/**
 * Wires the local AI copilot into React: install stream, activation, chat, reports and the
 * human gate on proposals.
 *
 * The hook owns nothing but the copilot's own view state. Every scenario mutation it can
 * trigger (a confirmed proposal) is handed back to the caller so it travels through the
 * same revision guard as every other command.
 */

import { useCallback, useEffect, useState, type MutableRefObject } from 'react';

import {
  ApiRequestError,
  activateModel,
  askCopilot,
  confirmProposal,
  createCommandId,
  installModel,
  openInstallStream,
  rejectProposal,
  requestShiftReport,
  type ChatTurn,
} from '../api/client';
import { acceptAiAnswer, type RevisionGuardState } from '../scenario/revision-guard';
import type { ScenarioSnapshot } from '../scenario/scenario';
import {
  describeAiError,
  INITIAL_INSTALL_PROGRESS,
  isInstalling,
  parseChatResponse,
  parseInstallEvent,
  parseShiftReport,
  reduceInstallProgress,
  reportDownload,
  type AiChatAnswer,
  type AiReport,
  type InstallProgress,
} from './ai-copilot';
import { INACTIVE_AI_STATUS, toAiStatus, type AiStatus } from './readiness';

export interface UseAiCopilotOptions {
  snapshot: ScenarioSnapshot | null;
  guardRef: MutableRefObject<RevisionGuardState>;
  /** Apply a snapshot produced by a copilot command through the shared revision guard. */
  onScenarioCommand: (snapshot: ScenarioSnapshot, commandId: string | null) => void;
  /** Re-probe readiness after the install or the activation changed the AI state. */
  onAiStateChanged: () => void;
}

export interface AiCopilotController {
  status: AiStatus;
  install: InstallProgress;
  installing: boolean;
  installBusy: boolean;
  activating: boolean;
  chatBusy: boolean;
  reportBusy: boolean;
  proposalBusy: boolean;
  error: string | null;
  notice: string | null;
  answer: AiChatAnswer | null;
  answerStale: boolean;
  report: AiReport | null;
  onInstall: () => void;
  onActivate: () => void;
  onAsk: (question: string) => void;
  onGenerateReport: () => void;
  onDownloadReport: () => void;
  onConfirmProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
}

export function useAiCopilot({
  snapshot,
  guardRef,
  onScenarioCommand,
  onAiStateChanged,
}: UseAiCopilotOptions): AiCopilotController {
  const [status, setStatus] = useState<AiStatus>(INACTIVE_AI_STATUS);
  const [install, setInstall] = useState<InstallProgress>(INITIAL_INSTALL_PROGRESS);
  const [installBusy, setInstallBusy] = useState(false);
  const [activating, setActivating] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AiChatAnswer | null>(null);
  const [report, setReport] = useState<AiReport | null>(null);
  const [streamKey, setStreamKey] = useState(0);

  // The stream is re-opened on demand: the backend closes it on the terminal state, and a
  // reconnecting EventSource would otherwise loop against an already finished download.
  useEffect(() => {
    const source = openInstallStream();
    if (source === null) return undefined;
    let closed = false;
    const handleInstall = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const next = parseInstallEvent(parsed);
      if (next === null) return;
      setInstall((current) => reduceInstallProgress(current, next));
      if (next.state === 'COMPLETED' || next.state === 'FAILED') {
        if (!closed) {
          closed = true;
          source.close();
        }
        onAiStateChanged();
      }
    };
    const handleStatus = (event: MessageEvent<string>) => {
      try {
        setStatus(toAiStatus(JSON.parse(event.data)?.payload));
      } catch {
        // A malformed status frame must not disturb the panel.
      }
    };
    source.addEventListener('ai.install', handleInstall as EventListener);
    source.addEventListener('ai.status', handleStatus as EventListener);
    return () => {
      closed = true;
      source.removeEventListener('ai.install', handleInstall as EventListener);
      source.removeEventListener('ai.status', handleStatus as EventListener);
      source.close();
    };
  }, [streamKey, onAiStateChanged]);

  const onInstall = useCallback(() => {
    setInstallBusy(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        await installModel();
        onAiStateChanged();
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        // Re-subscribe either way: the progress endpoint is the recovery path after a
        // failure, so the panel must not depend on the POST having succeeded.
        setStreamKey((key) => key + 1);
        setInstallBusy(false);
      }
    })();
  }, [onAiStateChanged]);

  const onActivate = useCallback(() => {
    setActivating(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        setStatus(toAiStatus(await activateModel()));
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setActivating(false);
        onAiStateChanged();
      }
    })();
  }, [onAiStateChanged]);

  const onAsk = useCallback(
    (question: string) => {
      if (!snapshot) return;
      const trimmed = question.trim();
      if (!trimmed) return;
      setChatBusy(true);
      setError(null);
      setNotice(null);
      void (async () => {
        try {
          const history: ChatTurn[] = [{ role: 'user', content: trimmed }];
          const raw = await askCopilot<unknown>(
            snapshot.scenarioId,
            snapshot.scenarioRevision,
            history,
          );
          const parsed = parseChatResponse(raw);
          if (parsed === null) {
            setError('The copilot answered with something the contract rejects.');
            return;
          }
          if (!acceptAiAnswer(guardRef.current, parsed.usedRevision)) {
            // The scenario moved on while the model was writing: keep the answer out of the
            // way instead of describing a plan that no longer exists.
            setNotice(
              'The scenario changed while the copilot was answering. Ask again for the current revision.',
            );
            return;
          }
          setAnswer(parsed);
        } catch (failure) {
          setError(errorMessage(failure));
        } finally {
          setChatBusy(false);
        }
      })();
    },
    [guardRef, snapshot],
  );

  const onGenerateReport = useCallback(() => {
    if (!snapshot) return;
    setReportBusy(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        const raw = await requestShiftReport<unknown>(
          snapshot.scenarioId,
          snapshot.scenarioRevision,
        );
        const parsed = parseShiftReport(raw);
        if (parsed === null) {
          setError('The shift report did not match the frozen contract.');
          return;
        }
        setReport(parsed);
      } catch (failure) {
        setError(errorMessage(failure));
      } finally {
        setReportBusy(false);
      }
    })();
  }, [snapshot]);

  const onDownloadReport = useCallback(() => {
    if (!report) return;
    triggerDownload(reportDownload(report));
  }, [report]);

  const resolveProposal = useCallback(
    (proposalId: string, decision: 'confirm' | 'reject') => {
      if (!snapshot) return;
      const commandId = createCommandId();
      setProposalBusy(true);
      setError(null);
      setNotice(null);
      void (async () => {
        try {
          const raw =
            decision === 'confirm'
              ? await confirmProposal<unknown>(
                  proposalId,
                  snapshot.scenarioRevision,
                  { commandId },
                )
              : await rejectProposal<unknown>(
                  proposalId,
                  snapshot.scenarioRevision,
                  { commandId },
                );
          const next = raw as ScenarioSnapshot;
          if (next && typeof next.scenarioRevision === 'number') {
            onScenarioCommand(next, commandId);
          }
          setAnswer((current) =>
            current && current.proposal?.proposalId === proposalId
              ? {
                  ...current,
                  proposal: {
                    ...current.proposal,
                    status: decision === 'confirm' ? 'CONFIRMED' : 'REJECTED',
                  },
                }
              : current,
          );
          setNotice(
            decision === 'confirm'
              ? 'Proposal applied. The revision below already includes the change.'
              : 'Proposal rejected. No action was executed.',
          );
        } catch (failure) {
          setError(errorMessage(failure));
        } finally {
          setProposalBusy(false);
        }
      })();
    },
    [onScenarioCommand, snapshot],
  );

  const onConfirmProposal = useCallback(
    (proposalId: string) => resolveProposal(proposalId, 'confirm'),
    [resolveProposal],
  );
  const onRejectProposal = useCallback(
    (proposalId: string) => resolveProposal(proposalId, 'reject'),
    [resolveProposal],
  );

  return {
    status,
    install,
    installing: isInstalling(install),
    installBusy,
    activating,
    chatBusy,
    reportBusy,
    proposalBusy,
    error,
    notice,
    answer,
    answerStale: answer !== null && answer.usedRevision !== snapshot?.scenarioRevision,
    report,
    onInstall,
    onActivate,
    onAsk,
    onGenerateReport,
    onDownloadReport,
    onConfirmProposal,
    onRejectProposal,
  };
}

function errorMessage(failure: unknown): string {
  if (failure instanceof ApiRequestError) {
    return describeAiError(failure.code, failure.message);
  }
  if (failure instanceof Error) return failure.message;
  return 'The copilot request failed.';
}

function triggerDownload(download: { fileName: string; content: string }): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
  const blob = new Blob([download.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = download.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

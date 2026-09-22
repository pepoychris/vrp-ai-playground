/**
 * The local AI copilot: install, activation, grounded chat, shift report and the human
 * gate on proposals.
 *
 * The panel is presentational. It renders exactly what the backend validated: the AI
 * service state, the install progress the stream reported, the answer with the revision it
 * was grounded on, and the report the user can download. It offers no way to choose a
 * model, reach Ollama or apply an action without confirming it.
 */

import { useState } from 'react';

import {
  aiReadinessCopy,
  describeProposalKind,
  installProgressDetail,
  installProgressLabel,
  installProgressRatio,
  proposalTarget,
  type AiChatAnswer,
  type AiReport,
  type InstallProgress,
} from '../state/ai-copilot';
import type { AiStatus } from '../state/readiness';
import type { ScenarioSnapshot } from '../scenario/scenario';

export interface AiCopilotPanelProps {
  snapshot: ScenarioSnapshot | null;
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

const EXAMPLE_QUESTIONS = [
  '¿Por que cambio la ruta de R-01?',
  '¿Que pedidos se han quedado sin asignar y por que?',
];

export function AiCopilotPanel({
  snapshot,
  status,
  install,
  installing,
  installBusy,
  activating,
  chatBusy,
  reportBusy,
  proposalBusy,
  error,
  notice,
  answer,
  answerStale,
  report,
  onInstall,
  onActivate,
  onAsk,
  onGenerateReport,
  onDownloadReport,
  onConfirmProposal,
  onRejectProposal,
}: AiCopilotPanelProps) {
  const [question, setQuestion] = useState('');
  const copy = aiReadinessCopy(status);
  const ratio = installProgressRatio(install);
  const proposal = answer?.proposal ?? null;
  const canAsk = Boolean(snapshot) && !chatBusy;

  return (
    <section className="panel ai-copilot" aria-labelledby="ai-copilot-heading">
      <h2 id="ai-copilot-heading">AI copilot</h2>

      <div className="ai-status" aria-label="AI service state">
        <span className={status.serviceAvailable ? 'state state--ok' : 'state state--off'}>
          Service {copy.service}
        </span>
        <span className={status.modelInstalled ? 'state state--ok' : 'state state--off'}>
          Model {copy.installed}
        </span>
        <span className={status.modelLoaded ? 'state state--ok' : 'state state--idle'}>
          Core {copy.loaded}
        </span>
      </div>

      <div className="button-row">
        <button
          type="button"
          className="refresh"
          disabled={installBusy || installing || status.modelInstalled}
          onClick={onInstall}
        >
          {install.state === 'FAILED' ? 'Retry Qwen Core install' : 'Install Qwen Core'}
        </button>
        <button
          type="button"
          className="refresh"
          disabled={activating || !status.modelInstalled || status.modelLoaded}
          onClick={onActivate}
        >
          {activating ? 'Activating' : 'Activate AI core'}
        </button>
      </div>

      <div className="ai-progress" role="status" aria-label="Model install progress">
        <div
          className="progress"
          role="progressbar"
          aria-label="Model download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
          aria-valuetext={installProgressLabel(install)}
        >
          <div className="progress__fill" style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} />
        </div>
        <p className="panel__note" data-testid="install-label">
          {installProgressLabel(install)}
        </p>
        <p className="panel__note">{installProgressDetail(install)}</p>
      </div>

      <section className="ai-chat" aria-label="Copilot chat">
        <h3 className="ai-heading">Ask about the current revision</h3>
        <label className="ai-question">
          Question
          <textarea
            aria-label="Copilot question"
            rows={2}
            value={question}
            placeholder={EXAMPLE_QUESTIONS[0]}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={!canAsk}
          />
        </label>
        <div className="button-row">
          <button
            type="button"
            className="refresh"
            disabled={!canAsk || !question.trim()}
            onClick={() => {
              onAsk(question);
              setQuestion('');
            }}
          >
            {chatBusy ? 'Asking the copilot' : 'Ask the copilot'}
          </button>
        </div>
        {snapshot ? (
          <p className="panel__note">
            Answers are grounded on revision {snapshot.scenarioRevision} and cannot change the
            scenario on their own.
          </p>
        ) : (
          <p className="panel__note">Create a colony first: the copilot only reads a scenario.</p>
        )}
      </section>

      {answer ? (
        <section className="ai-answer" aria-label="Copilot answer">
          <h3 className="ai-heading">Answer · revision {answer.usedRevision}</h3>
          <p className="ai-answer__text">{answer.answer}</p>
          {answer.references.length > 0 ? (
            <ul className="ai-references" aria-label="Grounded fields">
              {answer.references.map((reference) => (
                <li key={reference}>{reference}</li>
              ))}
            </ul>
          ) : null}
          {answerStale ? (
            <p className="panel__error" role="alert">
              This answer describes revision {answer.usedRevision}, which is no longer current.
            </p>
          ) : null}
          {proposal ? (
            <div className="ai-proposal" aria-label="Suggested action">
              <h4 className="ai-heading">{describeProposalKind(proposal.kind)}</h4>
              <p className="panel__note">{proposal.summary}</p>
              <p className="panel__note">
                Proposal {proposal.proposalId}
                {proposalTarget(proposal) ? ` · target ${proposalTarget(proposal)}` : ''}
                {proposal.revisionToApply === null
                  ? ''
                  : ` · computed on revision ${proposal.revisionToApply}`}
              </p>
              {proposal.status === 'PENDING' ? (
                <div className="button-row">
                  <button
                    type="button"
                    className="refresh"
                    disabled={proposalBusy}
                    onClick={() => onConfirmProposal(proposal.proposalId)}
                  >
                    Confirm and apply
                  </button>
                  <button
                    type="button"
                    className="refresh"
                    disabled={proposalBusy}
                    onClick={() => onRejectProposal(proposal.proposalId)}
                  >
                    Reject proposal
                  </button>
                </div>
              ) : (
                <p className="panel__note">Proposal {proposal.status.toLowerCase()}.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="ai-report" aria-label="Shift report">
        <h3 className="ai-heading">Shift report</h3>
        <div className="button-row">
          <button
            type="button"
            className="refresh"
            disabled={!snapshot || reportBusy}
            onClick={onGenerateReport}
          >
            {reportBusy ? 'Building the report' : 'Build shift report'}
          </button>
          <button
            type="button"
            className="refresh"
            disabled={!report}
            onClick={onDownloadReport}
          >
            Download report (Markdown)
          </button>
        </div>
        {report ? (
          <p className="panel__note">
            Schema {report.schemaVersion} · revision {report.scenarioRevision} · generated at{' '}
            {report.generatedAt}. It includes the A/B comparison against the previous plan.
          </p>
        ) : (
          <p className="panel__note">
            The report carries the plan metrics and the before/after comparison of the last
            intervention.
          </p>
        )}
      </section>

      {notice ? <p className="panel__note" role="status">{notice}</p> : null}
      {error ? (
        <p className="panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

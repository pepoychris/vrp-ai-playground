/*
 * VRP AI Playground project page.
 *
 * No dependencies: a small step player for the two demos, the install animation of the
 * re-created copilot panel, the report viewer and the copy buttons. Everything runs from
 * the file system as well as from GitHub Pages.
 */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ICONS = {
    prev:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>',
    next:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    play:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  };

  function slideTitle(slide) {
    var heading = slide.querySelector('.slide__caption h4');
    return heading ? heading.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /* ------------------------------------------------------------------ player */

  function Player(root) {
    this.root = root;
    this.slides = Array.prototype.slice.call(root.querySelectorAll('.slide'));
    this.controls = root.querySelector('[data-controls]');
    this.dots = root.querySelector('[data-dots]');
    this.counter = root.querySelector('[data-counter]');
    this.progress = root.querySelector('[data-progress]');
    this.live = root.querySelector('[data-live]');
    this.index = Math.max(
      0,
      this.slides.findIndex(function (slide) {
        return slide.classList.contains('is-active');
      }),
    );
    this.timer = null;
    this.playing = false;
    this.interval = Number(root.getAttribute('data-autoplay')) || 7000;
    this.onStep = typeof this.root.__onStep === 'function' ? this.root.__onStep : null;
    this.build();
    this.show(this.index, false);
  }

  Player.prototype.build = function () {
    var self = this;

    this.prev = button('icon-btn', ICONS.prev, 'Previous step');
    this.play = button('icon-btn', ICONS.play, 'Play the demo');
    this.play.setAttribute('aria-pressed', 'false');
    this.next = button('icon-btn', ICONS.next, 'Next step');

    this.prev.addEventListener('click', function () {
      self.userAction();
      self.show(self.index - 1);
    });
    this.next.addEventListener('click', function () {
      self.userAction();
      self.show(self.index + 1);
    });
    this.play.addEventListener('click', function () {
      self.toggle();
    });

    this.controls.appendChild(this.prev);
    this.controls.appendChild(this.play);
    this.controls.appendChild(this.next);

    this.slides.forEach(function (slide, index) {
      var dot = document.createElement('button');
      dot.type = 'button';
      dot.textContent = String(index + 1).padStart(2, '0');
      dot.setAttribute('aria-label', 'Go to step ' + (index + 1) + ': ' + slideTitle(slide));
      dot.addEventListener('click', function () {
        self.userAction();
        self.show(index);
      });
      self.dots.appendChild(dot);
    });

    this.root.addEventListener('keydown', function (event) {
      var key = event.key;
      if (key === 'ArrowLeft') {
        self.userAction();
        self.show(self.index - 1);
      } else if (key === 'ArrowRight') {
        self.userAction();
        self.show(self.index + 1);
      } else if (key === 'Home') {
        self.userAction();
        self.show(0);
      } else if (key === 'End') {
        self.userAction();
        self.show(self.slides.length - 1);
      } else if (key === ' ' || key === 'Spacebar') {
        self.toggle();
      } else if (key === 'Enter' && event.target === self.root) {
        self.toggle();
      } else {
        return;
      }
      event.preventDefault();
    });

    // Autoplay only while the player is on screen, and never under reduced motion.
    if (!reduceMotion && 'IntersectionObserver' in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting && !self.pausedByUser) {
              self.start();
            } else {
              self.stop();
            }
          });
        },
        { threshold: 0.35 },
      );
      observer.observe(this.root);
    }
  };

  Player.prototype.toggle = function () {
    if (this.playing) {
      this.pausedByUser = true;
      this.stop();
    } else {
      this.pausedByUser = false;
      this.start();
    }
  };

  Player.prototype.userAction = function () {
    this.pausedByUser = true;
    this.stop();
  };

  Player.prototype.start = function () {
    var self = this;
    this.playing = true;
    this.play.innerHTML = ICONS.pause;
    this.play.setAttribute('aria-label', 'Pause the demo');
    this.play.setAttribute('aria-pressed', 'true');
    window.clearInterval(this.timer);
    this.timer = window.setInterval(function () {
      self.show(self.index + 1, true);
    }, this.interval);
  };

  Player.prototype.stop = function () {
    this.playing = false;
    window.clearInterval(this.timer);
    this.timer = null;
    this.play.innerHTML = ICONS.play;
    this.play.setAttribute('aria-label', 'Play the demo');
    this.play.setAttribute('aria-pressed', 'false');
  };

  Player.prototype.show = function (index, fromTimer) {
    var total = this.slides.length;
    var target = ((index % total) + total) % total;
    var self = this;

    if (target === this.index && fromTimer) return;

    this.index = target;

    this.slides.forEach(function (slide, position) {
      var active = position === target;
      slide.classList.toggle('is-active', active);
      if (active) {
        slide.removeAttribute('hidden');
      } else {
        slide.setAttribute('hidden', '');
      }
    });

    Array.prototype.forEach.call(this.dots.children, function (dot, position) {
      var current = position === target;
      dot.setAttribute('aria-current', current ? 'true' : 'false');
    });

    this.counter.textContent = 'Step ' + (target + 1) + ' of ' + total;
    this.progress.style.width = ((target + 1) / total) * 100 + '%';
    this.prev.disabled = false;
    this.next.disabled = false;

    if (this.live) {
      this.live.textContent = 'Step ' + (target + 1) + ' of ' + total + ': ' + slideTitle(this.slides[target]);
    }

    if (this.onStep) {
      this.onStep(target, this.slides[target], self);
    }
  };

  function button(className, html, label) {
    var element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.innerHTML = html;
    element.setAttribute('aria-label', label);
    return element;
  }

  /* --------------------------------------------------- copilot install animation */

  var INSTALL_FRAMES = [
    { percent: 0, label: 'pulling manifest' },
    { percent: 11, label: 'pulling manifest' },
    { percent: 27, label: 'downloading 2.4 GB' },
    { percent: 48, label: 'downloading 2.4 GB' },
    { percent: 66, label: 'verifying sha256' },
    { percent: 79, label: 'extracting layers' },
    { percent: 91, label: 'writing to the volume' },
    { percent: 100, label: 'success - qwen3:4b installed' },
  ];

  function setupInstall() {
    var install = document.querySelector('[data-install]');
    if (!install) return null;

    var fill = install.querySelector('[data-install-fill]');
    var bar = install.querySelector('[data-install-bar]');
    var label = install.querySelector('[data-install-label]');
    var value = install.querySelector('[data-install-value]');
    var timer = null;

    function reset() {
      window.clearInterval(timer);
      timer = null;
      install.classList.remove('is-done');
      fill.style.width = '0%';
      bar.setAttribute('aria-valuenow', '0');
      value.textContent = '0%';
      label.textContent = INSTALL_FRAMES[0].label;
    }

    function run() {
      reset();
      if (reduceMotion) {
        apply(INSTALL_FRAMES.length - 1);
        return;
      }
      var step = 0;
      timer = window.setInterval(function () {
        step += 1;
        apply(step);
        if (step >= INSTALL_FRAMES.length - 1) {
          window.clearInterval(timer);
          timer = null;
        }
      }, 620);
    }

    function apply(step) {
      var frame = INSTALL_FRAMES[Math.min(step, INSTALL_FRAMES.length - 1)];
      fill.style.width = frame.percent + '%';
      bar.setAttribute('aria-valuenow', String(frame.percent));
      value.textContent = frame.percent + '%';
      label.textContent = frame.label;
      install.classList.toggle('is-done', frame.percent === 100);
    }

    reset();
    return { start: run, reset: reset };
  }

  /* ------------------------------------------------------------------- report */

  var REPORT_MARKDOWN = [
    '# Shift report - revision 5',
    '',
    'Generated: 2026-09-22T09:12:31.004Z | Status: RUNNING | Plan available: yes',
    '',
    '## Summary',
    '',
    "Barrier B-1 closed edge E-N002-N007 at revision 5, and the solver re-planned R-01",
    'around it. Total distance grew from 600 m to 840 m and the planned duration from',
    '270 s to 294 s. Order O-003 is unassigned because the deployed capacity cannot',
    'serve it; R-01 is already at 73.3% load. No order is delayed.',
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| Vehicles | 2 |',
    '| Orders | 3 |',
    '| Active vehicles | 1 |',
    '| Total distance | 840 m |',
    '| Planned duration | 294 s |',
    '| Economic cost | 2070 c |',
    '| Delayed orders | 0 |',
    '| Unassigned orders | 1 |',
    '',
    '## Before and after (revision 4 -> revision 5)',
    '',
    '| Metric | Revision 4 | Revision 5 | Delta |',
    '| --- | --- | --- | --- |',
    '| Distance | 600 m | 840 m | +240 m |',
    '| Planned duration | 270 s | 294 s | +24 s |',
    '| Economic cost | 2050 c | 2070 c | +20 c |',
    '| Unassigned orders | 1 | 1 | 0 |',
    '| Delayed orders | 0 | 0 | 0 |',
    '',
    '## Plan',
    '',
    '- R-01: N-001 -> N-002 -> N-005 -> N-006 -> N-007, 840 m, 294 s, 73.3% load.',
    '  Serves O-001 (N-006) and O-002 (N-007).',
    '- R-02: stays at the depot, no stops.',
    '- Unassigned: O-003, reason NO_CAPACITY.',
    '- Closures: B-1 blocks E-N002-N007.',
    '',
    '## Highlights',
    '',
    '- The detour respects every time window; no order is delayed.',
    '- Only one of the two deployed robots is needed for the assigned stops.',
    '',
    '## Risks',
    '',
    '- O-003 cannot be served by the current fleet: capacity is the binding constraint.',
    '',
    '## Recommendations',
    '',
    '- Deploy a third robot before the next shift, or raise the capacity of R-01.',
    '- Keep B-1 only while the south dock access is unavailable: it costs 240 m per plan.',
    '',
    '---',
    '',
    'Rendered from the structured aiReportResponse of the frozen golden example.',
    '',
  ].join('\n');

  function downloadReport() {
    var blob = new Blob([REPORT_MARKDOWN], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'shift-report-revision-5.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function setupReport() {
    var dialog = document.querySelector('[data-report-dialog]');
    var meta = dialog ? dialog.querySelector('[data-report-meta]') : null;
    if (meta) {
      meta.textContent =
        'scenarioRevision 5 | status RUNNING | generated 2026-09-22T09:12:31.004Z | schemaVersion 1.0';
    }

    Array.prototype.forEach.call(
      document.querySelectorAll('[data-open-report]'),
      function (trigger) {
        trigger.addEventListener('click', function () {
          if (!dialog) return;
          if (typeof dialog.showModal === 'function') {
            dialog.showModal();
          } else {
            dialog.setAttribute('open', '');
          }
        });
      },
    );

    Array.prototype.forEach.call(
      document.querySelectorAll('[data-download-report]'),
      function (trigger) {
        trigger.addEventListener('click', downloadReport);
      },
    );
  }

  /* -------------------------------------------------------------- copy buttons */

  function setupCopy() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (button) {
      var original = button.textContent;
      button.addEventListener('click', function () {
        var text = button.getAttribute('data-copy') || '';
        var done = function () {
          button.textContent = 'Copied';
          window.setTimeout(function () {
            button.textContent = original;
          }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
        } else {
          done();
        }
      });
    });
  }

  /* --------------------------------------------------- illustrative controls */

  function setupIllustrative() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-noop]'), function (element) {
      element.setAttribute('aria-disabled', 'true');
      element.setAttribute('tabindex', '-1');
      element.setAttribute('title', 'Illustrative: this control works in the running application.');
      element.addEventListener('click', function (event) {
        event.preventDefault();
      });
    });
  }

  /* --------------------------------------------------------------------- boot */

  document.addEventListener('DOMContentLoaded', function () {
    var install = setupInstall();

    Array.prototype.forEach.call(document.querySelectorAll('[data-player]'), function (root) {
      var isCopilot = Boolean(root.closest('#demo-copilot'));
      var lastInstallIndex = null;
      root.__onStep = function (index) {
        if (!isCopilot || !install) return;
        // Step 2 of demo 2 rebuilds the download every time it is shown.
        if (index === 1) {
          if (lastInstallIndex !== 1) install.start();
        } else {
          install.reset();
        }
        lastInstallIndex = index;
      };
      var player = new Player(root);
      if (isCopilot && install) install.reset();
      root.__player = player;
    });

    setupReport();
    setupCopy();
    setupIllustrative();
  });
})();

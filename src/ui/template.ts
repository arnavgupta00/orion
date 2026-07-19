export function appTemplate(): string {
  return `
    <canvas id="solar-scene" class="solar-scene" aria-hidden="true"></canvas>
    <div class="atmosphere" aria-hidden="true"></div>
    <video id="camera-source" class="camera-source" playsinline muted></video>

    <header class="topline">
      <div class="system-label">
        <span class="system-beacon" aria-hidden="true"></span>
        <span class="orion-wordmark">ORION</span>
        <span id="input-label" class="input-source">LOCAL CAMERA</span>
        <span class="system-divider" aria-hidden="true"></span>
        <span id="hand-count">HANDS 0</span>
      </div>
      <div class="topline-actions">
        <button class="text-button info-button" type="button" data-action="guide" aria-label="Open Orion guide" aria-expanded="false">i</button>
        <button class="text-button" type="button" data-action="debug" aria-label="Toggle diagnostics">D</button>
        <button class="text-button" type="button" data-action="fullscreen" aria-label="Enter fullscreen">F</button>
      </div>
    </header>

    <section class="hero-state" aria-live="polite" aria-atomic="true">
      <span class="state-beacon" aria-hidden="true"></span>
      <div>
        <p class="state-index">CONTROL / <span id="state-index">00</span></p>
        <h1 id="status-word" class="status-word" data-text="READY" aria-label="READY">READY</h1>
      </div>
    </section>

    <div id="reticle-layer" class="reticle-layer" aria-hidden="true"></div>

    <aside class="status-rail" aria-label="Orion status">
      <span id="authority-status" data-tone="ambient">AMBIENT</span>
      <span id="voice-status">VOICE OFFLINE</span>
      <span id="session-status">SESSION —</span>
    </aside>

    <aside id="capability-runway" class="capability-runway" aria-labelledby="capability-runway-title">
      <div class="capability-runway__header">
        <span class="capability-runway__pulse" aria-hidden="true"></span>
        <p id="capability-runway-title">TRY ORION</p>
        <span id="capability-count">01 / 05</span>
        <button id="dismiss-capabilities" type="button" aria-label="Dismiss suggested prompts">×</button>
      </div>
      <div class="capability-voice-sequence" aria-label="Hold Space, speak, then release to send">
        <span><b>01</b><em>HOLD</em><kbd>SPACE</kbd></span>
        <i aria-hidden="true"></i>
        <span><b>02</b><em>SPEAK</em></span>
        <i aria-hidden="true"></i>
        <span><b>03</b><em>RELEASE</em></span>
      </div>
      <button id="capability-prompt" class="capability-prompt" type="button">
        <span id="capability-prompt-copy">Compare Arnav’s work to the latest agent trends, then open his GitHub.</span>
        <i aria-hidden="true">↗</i>
      </button>
      <div class="capability-chain" aria-label="Tools this prompt can use">
        <span>VOICE</span><i></i><span id="capability-chain-copy">EVIDENCE → LIVE SEARCH → NEW TAB</span>
      </div>
      <div id="capability-dots" class="capability-dots" aria-label="Suggested prompt selection"></div>
    </aside>

    <section id="voice-ribbon" class="voice-ribbon" aria-live="polite" data-clarity-mask="true" hidden>
      <div id="space-prompt" class="space-prompt" aria-label="Hold Space to speak">
        <kbd>SPACE</kbd>
      </div>
      <div class="voice-toolbar" aria-label="Orion voice controls">
        <button id="close-listening" class="voice-control voice-control--cancel" type="button" aria-label="Cancel listening" hidden>
          <span aria-hidden="true">×</span>
        </button>
        <button id="stop-speaking" class="voice-control voice-control--cancel" type="button" aria-label="Stop Orion speaking" hidden>
          <span aria-hidden="true">×</span>
        </button>
        <div id="waveform" class="waveform" aria-hidden="true">
          ${Array.from({ length: 20 }, (_, index) => `<i style="--i:${index}"></i>`).join('')}
        </div>
        <button id="finish-listening" class="voice-control voice-control--confirm" type="button" aria-label="Finish listening" hidden>
          <span aria-hidden="true">✓</span>
        </button>
      </div>
      <div class="transcript-line">
        <p id="live-transcript" class="live-transcript"></p>
      </div>
    </section>

    <section id="action-trace" class="action-trace" aria-label="Orion action progress" aria-live="polite" hidden>
      <span class="action-trace__signal" aria-hidden="true"></span>
      <ol id="action-trace-steps" class="action-trace__steps"></ol>
      <span id="action-trace-summary" class="action-trace__summary"></span>
    </section>

    <aside id="answer-panel" class="answer-panel" aria-label="Orion answer" data-clarity-mask="true" hidden>
      <div class="answer-heading">
        <span>ORION / DISPLAY</span>
        <button id="collapse-answer" type="button" aria-label="Collapse answer">×</button>
      </div>
      <div id="answer-text" class="answer-text" aria-live="polite"></div>
      <div id="tool-content" class="tool-content"></div>
      <div id="answer-sources" class="answer-sources"></div>
    </aside>

    <div id="orion-toast" class="orion-toast" role="status" hidden></div>
    <div id="turnstile-anchor" class="turnstile-anchor" aria-hidden="true"></div>

    <button class="guide-scrim" type="button" data-action="guide" aria-label="Close Orion guide" tabindex="-1"></button>
    <aside id="guide-panel" class="guide-panel" aria-labelledby="guide-title" aria-hidden="true" inert>
      <header class="guide-heading">
        <div>
          <p class="eyebrow">ORION / FIELD MANUAL</p>
          <h2 id="guide-title">Control the core.</h2>
        </div>
        <button class="guide-close" type="button" data-action="guide" aria-label="Close Orion guide">×</button>
      </header>

      <div class="guide-intro">
        <p>Use hands for direct spatial control. Voice can reason, search, control the scene, and act inside this Orion tab.</p>
        <span>Hand control always takes priority while a hand is visible.</span>
      </div>

      <section class="guide-section" aria-labelledby="guide-voice">
        <h3 id="guide-voice">Voice</h3>
        <dl class="guide-list">
          <div><dt>Hold <kbd>Space</kbd></dt><dd>Speak, then release to send.</dd></div>
          <div><dt>Double-tap <kbd>Space</kbd></dt><dd>Keep listening hands-free. Press Space or ✓ to finish.</dd></div>
          <div><dt><kbd>Space</kbd> while speaking</dt><dd>Interrupt Orion and begin a new turn.</dd></div>
          <div><dt><kbd>X</kbd></dt><dd>Stop Orion’s voice without reopening the microphone.</dd></div>
        </dl>
        <p class="guide-examples">TRY “OPEN THE FIELD” · “SHOW ARNAV’S GITHUB” · “CHECK THE LATEST AI NEWS” · “CHANGE THIS PAGE WITH JAVASCRIPT”</p>
      </section>

      <section class="guide-section" aria-labelledby="guide-agent-tools">
        <h3 id="guide-agent-tools">Agent tools</h3>
        <dl class="guide-list">
          <div><dt>Live sources</dt><dd>Search current information and inspect a public URL with visible citations.</dd></div>
          <div><dt>Arnav evidence</dt><dd>Answer career and project questions with confidence labels and caveats.</dd></div>
          <div><dt>Page actions</dt><dd>Run JavaScript in this Orion tab, change its interface, copy text, or prepare a new tab.</dd></div>
          <div><dt>Action trace</dt><dd>Watch every tool step below the core; longer work gets a brief spoken update.</dd></div>
        </dl>
      </section>

      <section class="guide-section guide-try" aria-labelledby="guide-try">
        <h3 id="guide-try">Try a full chain</h3>
        <button type="button" data-suggest="Compare Arnav’s work to the latest agent trends, then open his GitHub.">
          <span>Evidence + current web + browser action</span>
          Compare Arnav’s work to current agent trends, then open his GitHub.
        </button>
        <button type="button" data-suggest="Use JavaScript to make this interface react to my next word.">
          <span>In-tab JavaScript</span>
          Make this interface react to my next word.
        </button>
        <button type="button" data-suggest="Open the field, zoom through it, then spin slowly.">
          <span>Multi-action scene control</span>
          Open the field, travel through it, then spin slowly.
        </button>
      </section>

      <section class="guide-section" aria-labelledby="guide-hands">
        <h3 id="guide-hands">Hands</h3>
        <dl class="guide-list guide-list--gestures">
          <div><dt>One hand</dt><dd>Wake the core and reveal your reticle.</dd></div>
          <div><dt>Pinch + drag</dt><dd>Begin inside the orb, then move to rotate it.</dd></div>
          <div><dt>Two pinches</dt><dd>Move hands apart or together for infinite-depth zoom. Rotate their angle to roll.</dd></div>
          <div><dt>Fist → rapid open</dt><dd>Charge the core, then release a controlled energy burst.</dd></div>
          <div><dt>Opposing palms</dt><dd>Hold on both sides, contract slightly to arm, then sweep outward to unfold the field.</dd></div>
          <div><dt>Open field + two pinches</dt><dd>Rotate and travel through the dispersed lattice.</dd></div>
          <div><dt>Two fists</dt><dd>Collapse the open field back into the core.</dd></div>
          <div><dt>Release</dt><dd>Open both hands before starting the next dual gesture.</dd></div>
        </dl>
      </section>

      <section class="guide-section" aria-labelledby="guide-calibration">
        <h3 id="guide-calibration">Calibration</h3>
        <p>Use the same single hand for all four targets. Pinch each marker, then open your fingers before moving to the next one.</p>
      </section>

      <section class="guide-section guide-shortcuts" aria-labelledby="guide-keys">
        <h3 id="guide-keys">System keys</h3>
        <p><kbd>C</kbd> recalibrate · <kbd>D</kbd> diagnostics · <kbd>F</kbd> fullscreen · <kbd>I</kbd> this guide</p>
      </section>
    </aside>

    <footer class="gesture-footer">
      <div class="gesture-instruction">
        <span class="instruction-rule" aria-hidden="true"></span>
        <span id="gesture-hint">Start the camera, then raise one hand.</span>
      </div>
      <div class="session-status">
        <span id="quality-label">TRACKING —</span>
        <span id="fps-label">RENDER —</span>
      </div>
    </footer>

    <section id="setup-overlay" class="setup-overlay" aria-labelledby="setup-title">
      <div id="start-panel" class="setup-panel start-panel">
        <div class="setup-copy">
          <p class="eyebrow">LOCAL VISION / VOICE INTELLIGENCE</p>
          <h2 id="setup-title"><span>Ori</span><span>on</span></h2>
          <p class="setup-description">
            Shape the core with your hands, or hold Space and speak to Orion. Camera and microphone
            permissions are independent; either interface remains useful on its own.
          </p>
          <div class="setup-intelligence" aria-label="Orion agent capabilities">
            <p>ONE VOICE / MULTIPLE SYSTEMS</p>
            <div aria-hidden="true"><span>ASK</span><i></i><span>REASON</span><i></i><span>ACT</span></div>
            <small>Live web · Arnav evidence · orb control · in-tab JavaScript</small>
          </div>
        </div>
        <div class="setup-action">
          <div class="privacy-note">
            <span>PRIVACY</span>
            <strong>Camera stays on this device</strong>
            <p>Audio streams only while listening. Conversation is never persisted.</p>
          </div>
          <div id="owner-access" class="owner-access" data-clarity-mask="true" hidden>
            <label for="owner-access-code">OWNER SESSION OVERRIDE</label>
            <input id="owner-access-code" type="password" autocomplete="off" spellcheck="false" placeholder="Paste access code" />
            <p>Creates an unrestricted owner session. The code stays in memory for this page.</p>
          </div>
          <button id="enter-orion" class="primary-action" type="button">
            <span>Enter Orion</span>
            <span aria-hidden="true">↗</span>
          </button>
          <p id="model-status" class="model-status">Camera and microphone will be requested separately.</p>
        </div>
      </div>

      <div id="calibration-panel" class="setup-panel calibration-panel" hidden>
        <div class="calibration-copy">
          <p class="eyebrow">CALIBRATION / <span id="calibration-count">1 OF 4</span></p>
          <h2>Pinch the <span id="target-name">upper-left</span> marker.</h2>
          <p>Use the same single hand for all four markers. Open your fingers between each pinch.</p>
          <button id="default-calibration" class="secondary-action" type="button">Use default range</button>
        </div>
        <div id="calibration-stage" class="calibration-stage">
          <canvas id="calibration-preview" class="camera-preview"></canvas>
          <span class="preview-label">MIRRORED CAMERA</span>
          <div id="calibration-target" class="calibration-target" aria-hidden="true">
            <span></span>
          </div>
          <div id="calibration-reticle" class="calibration-reticle" aria-hidden="true"></div>
          <div class="calibration-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        </div>
      </div>
    </section>

    <aside id="debug-panel" class="debug-panel" aria-label="Diagnostics" aria-hidden="true" inert>
      <div class="debug-heading">
        <div>
          <p class="eyebrow">LIVE / DIAGNOSTICS</p>
          <h2>Tracking</h2>
        </div>
        <button class="icon-button" type="button" data-action="debug" aria-label="Close diagnostics">×</button>
      </div>
      <canvas id="debug-preview" class="debug-preview"></canvas>
      <label class="camera-select-label" for="camera-select">Camera</label>
      <select id="camera-select" class="camera-select"></select>
      <dl class="debug-stats">
        <div><dt>Hands</dt><dd id="debug-hands">0</dd></div>
        <div><dt>Tracking</dt><dd id="debug-tracking-fps">—</dd></div>
        <div><dt>Render</dt><dd id="debug-render-fps">—</dd></div>
        <div><dt>Inference</dt><dd id="debug-inference">—</dd></div>
        <div><dt>Delegate</dt><dd id="debug-delegate">—</dd></div>
        <div><dt>Dropped</dt><dd id="debug-dropped">0</dd></div>
      </dl>
      <div class="debug-shortcuts">
        <span><kbd>C</kbd> Recalibrate</span>
        <span><kbd>F</kbd> Fullscreen</span>
        <span><kbd>D</kbd> Close</span>
      </div>
    </aside>

    <section id="error-panel" class="error-panel" role="alertdialog" aria-modal="true" hidden>
      <div>
        <p class="eyebrow">CONTROL INTERRUPTED</p>
        <h2 id="error-title">Orion unavailable</h2>
        <p id="error-message">Check browser permissions, then retry.</p>
        <button id="retry-button" class="primary-action" type="button"><span>Retry</span><span aria-hidden="true">↻</span></button>
      </div>
    </section>
  `;
}

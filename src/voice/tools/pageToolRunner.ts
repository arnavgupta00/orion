import type {
  ClientState,
  ClientToolName,
  ClientToolResult,
  OrbCommand,
  PageScriptResult,
} from '../types';

const MAX_SCRIPT_CHARACTERS = 12_000;
const MAX_RESULT_CHARACTERS = 8_000;
const MAX_LOG_LINES = 50;

export interface PageToolRunnerCallbacks {
  onCommand(command: OrbCommand, label: string): boolean;
  getClientState(): ClientState;
}

interface ToolCall {
  callId: string;
  tool: ClientToolName;
  args: Record<string, unknown>;
}

interface OrionPageApi {
  openUrl(url: string): Promise<unknown>;
  copyText(text: string): Promise<unknown>;
  toggleFullscreen(state?: 'enter' | 'exit' | 'toggle'): Promise<unknown>;
  getState(): ClientState;
  orb: {
    setField(state: 'open' | 'collapsed'): unknown;
    transform(values: Record<string, unknown>): unknown;
    setMotion(values: Record<string, unknown>): unknown;
    setCore(values: Record<string, unknown>): unknown;
    setAppearance(values: Record<string, unknown>): unknown;
    effect(effect: string, strength?: number): unknown;
  };
  ui: {
    showContent(values: Record<string, unknown>): unknown;
    modify(values: Record<string, unknown>): unknown;
  };
}

export class PageToolRunner {
  constructor(private readonly callbacks: PageToolRunnerCallbacks) {}

  async execute(call: ToolCall): Promise<ClientToolResult> {
    try {
      const result = await this.executeTool(call.tool, call.args);
      if (isRecord(result) && result.status === 'failed') {
        return {
          callId: call.callId,
          tool: call.tool,
          status: 'failed',
          result: serializableValue(result),
          error: typeof result.error === 'string' ? result.error : 'The page command failed.',
        };
      }
      const status = isRecord(result) && result.status === 'popup_blocked' ? 'popup_blocked' : 'completed';
      return { callId: call.callId, tool: call.tool, status, result: serializableValue(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The page command failed.';
      const rejected = message === 'HAND CONTROL ACTIVE';
      return {
        callId: call.callId,
        tool: call.tool,
        status: rejected ? 'rejected' : 'failed',
        error: message,
      };
    }
  }

  private async executeTool(tool: ClientToolName, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case 'orb_set_field':
        return this.applyCommands([{ kind: 'field', state: args.state === 'open' ? 'open' : 'collapsed' }], 'FIELD UPDATED');
      case 'orb_transform':
        return this.applyCommands(transformCommands(args), 'CORE TRANSFORMED');
      case 'orb_set_motion':
        return this.applyCommands(motionCommands(args), 'MOTION UPDATED');
      case 'orb_set_core':
        return this.applyCommands([{ kind: 'core',
          ...(finite(args.size) !== undefined ? { size: finite(args.size) } : {}),
          ...(finite(args.brightness) !== undefined ? { brightness: finite(args.brightness) } : {}),
          ...(finite(args.energy) !== undefined ? { energy: finite(args.energy) } : {}),
        }], 'CORE ENERGY UPDATED');
      case 'orb_set_appearance':
        return this.applyCommands([appearanceCommand(args)], 'ORB APPEARANCE UPDATED');
      case 'orb_effect':
        return this.applyCommands(effectCommands(args), 'EFFECT RELEASED');
      case 'open_url':
        return this.openUrl(String(args.url ?? ''));
      case 'show_content':
        return this.showContent(args);
      case 'modify_orion_ui':
        return this.modifyUi(args);
      case 'toggle_fullscreen':
        return this.toggleFullscreen(normalizeFullscreenState(args.state));
      case 'copy_text':
        return this.copyText(String(args.text ?? ''));
      case 'inspect_orion_state':
        return this.callbacks.getClientState();
      case 'run_page_javascript':
        return this.runJavascript(String(args.source ?? ''));
    }
  }

  private applyCommands(commands: OrbCommand[], label: string): { applied: number } {
    if (!commands.length) throw new Error('No valid orb transform was supplied.');
    let applied = 0;
    for (const command of commands) {
      if (!this.callbacks.onCommand(command, label)) throw new Error('HAND CONTROL ACTIVE');
      applied += 1;
    }
    return { applied };
  }

  private async runJavascript(source: string): Promise<PageScriptResult> {
    const started = performance.now();
    const logs: string[] = [];
    const openedUrls: string[] = [];
    if (!source.trim()) return { status: 'failed', logs, openedUrls, durationMs: 0, error: 'JavaScript source is empty.' };
    if (source.length > MAX_SCRIPT_CHARACTERS) return { status: 'failed', logs, openedUrls, durationMs: 0, error: 'JavaScript source exceeds the 12,000 character limit.' };

    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...values: unknown[]): void => {
      if (logs.length < MAX_LOG_LINES) logs.push(values.map(printableValue).join(' ').slice(0, 500));
    };
    console.log = (...values: unknown[]) => { capture(...values); original.log(...values); };
    console.warn = (...values: unknown[]) => { capture(...values); original.warn(...values); };
    console.error = (...values: unknown[]) => { capture(...values); original.error(...values); };

    try {
      const api = this.createApi(openedUrls);
      const AsyncFunction = Object.getPrototypeOf(async function () { /* dynamic Orion command */ }).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
      const execute = new AsyncFunction('orion', `"use strict";\n${source}`);
      const value = await execute(api);
      return {
        status: 'completed',
        value: serializableValue(value),
        logs,
        durationMs: Math.round(performance.now() - started),
        openedUrls,
      };
    } catch (error) {
      return {
        status: 'failed',
        logs,
        error: error instanceof Error ? error.message : 'JavaScript execution failed.',
        durationMs: Math.round(performance.now() - started),
        openedUrls,
      };
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
  }

  private createApi(openedUrls: string[]): OrionPageApi {
    return {
      openUrl: async (url) => {
        const result = this.openUrl(url);
        if (isRecord(result) && result.status === 'completed') openedUrls.push(String(result.url));
        return result;
      },
      copyText: (text) => this.copyText(text),
      toggleFullscreen: (state) => this.toggleFullscreen(state ?? 'toggle'),
      getState: () => this.callbacks.getClientState(),
      orb: {
        setField: (state) => this.applyCommands([{ kind: 'field', state }], 'FIELD UPDATED'),
        transform: (values) => this.applyCommands(transformCommands(values), 'CORE TRANSFORMED'),
        setMotion: (values) => this.applyCommands(motionCommands(values), 'MOTION UPDATED'),
        setCore: (values) => this.executeTool('orb_set_core', values),
        setAppearance: (values) => this.executeTool('orb_set_appearance', values),
        effect: (effect, strength) => this.applyCommands(effectCommands({ effect, strength }), 'EFFECT RELEASED'),
      },
      ui: {
        showContent: (values) => this.showContent(values),
        modify: (values) => this.modifyUi(values),
      },
    };
  }

  private openUrl(raw: string): Record<string, unknown> {
    const url = normalizeHttpUrl(raw);
    const opened = window.open(url, '_blank');
    if (opened) {
      opened.opener = null;
      return { status: 'completed', url };
    }
    this.showContent({ title: 'Page ready', text: 'Chrome blocked the automatic tab. Use Open to continue.', url, actionLabel: 'OPEN' });
    return { status: 'popup_blocked', url };
  }

  private showContent(args: Record<string, unknown>): { shown: true } {
    const panel = requiredElement<HTMLElement>('answer-panel');
    const container = requiredElement<HTMLElement>('tool-content');
    const card = document.createElement('section');
    card.className = 'tool-content-card';
    const title = String(args.title ?? '').trim();
    const text = String(args.text ?? args.body ?? '').trim();
    if (title) {
      const heading = document.createElement('h3');
      heading.textContent = title.slice(0, 160);
      card.append(heading);
    }
    if (text) {
      const body = document.createElement(args.format === 'code' ? 'pre' : 'p');
      body.textContent = text.slice(0, 8_000);
      card.append(body);
    }
    if (args.url) {
      const url = normalizeHttpUrl(String(args.url));
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = String(args.actionLabel ?? 'OPEN').slice(0, 32);
      card.append(link);
    }
    container.replaceChildren(card);
    panel.hidden = false;
    return { shown: true };
  }

  private modifyUi(args: Record<string, unknown>): Record<string, unknown> {
    const variables = Array.isArray(args.variables)
      ? args.variables.flatMap((entry) => isRecord(entry) ? [[String(entry.name ?? ''), entry.value] as const] : [])
      : isRecord(args.variables) ? Object.entries(args.variables) : [];
    for (const [name, value] of variables.slice(0, 16)) {
      if (name.startsWith('--') && typeof value === 'string') document.documentElement.style.setProperty(name, value.slice(0, 120));
    }
    const panel = String(args.panel ?? '');
    if (panel === 'answer') requiredElement<HTMLElement>('answer-panel').hidden = args.visible === false;
    if (panel === 'guide') document.body.classList.toggle('guide-open', args.visible !== false);
    if (typeof args.focusId === 'string') document.getElementById(args.focusId)?.focus();
    return { modified: true };
  }

  private async toggleFullscreen(state: 'enter' | 'exit' | 'toggle'): Promise<Record<string, unknown>> {
    const shouldEnter = state === 'enter' || (state === 'toggle' && !document.fullscreenElement);
    if (shouldEnter) await document.documentElement.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
    return { fullscreen: Boolean(document.fullscreenElement) };
  }

  private async copyText(text: string): Promise<Record<string, unknown>> {
    if (!text) throw new Error('There is no text to copy.');
    await navigator.clipboard.writeText(text.slice(0, 20_000));
    return { copied: true, characters: Math.min(text.length, 20_000) };
  }
}

export function normalizeHttpUrl(raw: string): string {
  const candidate = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^https?:/i.test(candidate)) {
    throw new Error('Only HTTP and HTTPS links can be opened.');
  }
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can be opened.');
  return url.toString();
}

export function serializableValue(value: unknown): unknown {
  if (value === undefined) return null;
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function') return `[Function ${item.name || 'anonymous'}]`;
      if (typeof Node !== 'undefined' && item instanceof Node) return `[${item.nodeName}]`;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    if (!json) return null;
    if (json.length <= MAX_RESULT_CHARACTERS) return JSON.parse(json) as unknown;
    return { truncated: true, preview: json.slice(0, MAX_RESULT_CHARACTERS) };
  } catch {
    return printableValue(value).slice(0, MAX_RESULT_CHARACTERS);
  }
}

function transformCommands(args: Record<string, unknown>): OrbCommand[] {
  const commands: OrbCommand[] = [];
  const zoom = finite(args.zoomFactor ?? args.factor);
  if (zoom !== undefined && zoom > 0 && zoom !== 1) commands.push({ kind: 'zoom', factor: zoom });
  const yaw = radians(args.yaw);
  const pitch = radians(args.pitch);
  const roll = radians(args.roll);
  if (yaw || pitch || roll) commands.push({ kind: 'rotate', yaw, pitch, roll, durationMs: bounded(args.durationMs, 850, 100, 8_000) });
  return commands;
}

function motionCommands(args: Record<string, unknown>): OrbCommand[] {
  if (args.action === 'stop') return [{ kind: 'stop-motion' }];
  const axis = ['x', 'y', 'z'].includes(String(args.axis)) ? String(args.axis) as 'x' | 'y' | 'z' : 'y';
  return [{ kind: 'spin', axis, speed: bounded(args.speed, 0.65, -3, 3) }];
}

function effectCommands(args: Record<string, unknown>): OrbCommand[] {
  const effect = String(args.effect ?? 'burst');
  if (effect === 'reset') return [{ kind: 'reset' }];
  if (effect === 'unfold') return [{ kind: 'field', state: 'open' }];
  if (effect === 'collapse') return [{ kind: 'field', state: 'collapsed' }];
  if (effect === 'charge') return [{ kind: 'core', energy: bounded(args.strength, 1.2, 0, 1.5) }];
  return [{ kind: 'burst', strength: bounded(args.strength, 1, 0.1, 2.5) }];
}

function appearanceCommand(args: Record<string, unknown>): OrbCommand {
  const target = ['shell', 'light-source', 'field', 'all'].includes(String(args.target))
    ? String(args.target) as 'shell' | 'light-source' | 'field' | 'all'
    : 'all';
  return { kind: 'appearance', target, color: normalizeOrbHexColor(args.color) };
}

export function normalizeOrbHexColor(value: unknown): string {
  const color = String(value ?? '').trim();
  const expanded = /^#([\da-f]{3})$/i.exec(color);
  if (expanded) {
    const [red, green, blue] = expanded[1]!.split('');
    return `#${red}${red}${green}${green}${blue}${blue}`.toUpperCase();
  }
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Orb color must be a six-digit hex color.');
  return color.toUpperCase();
}

function radians(value: unknown): number {
  return bounded(value, 0, -360, 360) * Math.PI / 180;
}

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const number = finite(value) ?? fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeFullscreenState(value: unknown): 'enter' | 'exit' | 'toggle' {
  return value === 'enter' || value === 'exit' ? value : 'toggle';
}

function printableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing Orion element #${id}.`);
  return node as T;
}

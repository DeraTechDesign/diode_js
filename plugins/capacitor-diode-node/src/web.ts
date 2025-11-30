import { WebPlugin } from '@capacitor/core';
import type {
  BindPortsOptions,
  BindResult,
  DiodeInitializeOptions,
  DiodeLogEntry,
  DiodeNodePlugin,
  DiodeStatus,
  LogSubscription,
  PublishPortsOptions,
  PublishResult,
} from './definitions';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

interface NodeMessage {
  kind?: 'response' | 'event';
  id?: string;
  success?: boolean;
  result?: any;
  error?: string;
  event?: string;
  data?: any;
}

let globalRequestCounter = 0;

export class DiodeNodeWeb extends WebPlugin implements DiodeNodePlugin {
  private nodejs: any | undefined;

  private nodeStarted = false;

  private startPromise: Promise<void> | null = null;

  private pending = new Map<string, PendingRequest>();

  private logListeners = new Set<(entry: DiodeLogEntry) => void>();

  private lastStatus: DiodeStatus | null = null;

  private scriptName = 'main.js';

  constructor() {
    super({ name: 'DiodeNode', platforms: ['android', 'ios', 'web'] });
  }

  private ensureNodeModule() {
    if (this.nodejs) {
      return;
    }
    const globalObject = typeof globalThis !== 'undefined' ? (globalThis as any) : (window as any);
    const cordovaRequire = typeof globalObject?.require === 'function' ? globalObject.require : undefined;

    if (cordovaRequire) {
      try {
        this.nodejs = cordovaRequire('nodejs-mobile-cordova');
      } catch (_) {
        // ignore and try global fallback
      }
    }

    if (!this.nodejs && globalObject?.nodejs) {
      this.nodejs = globalObject.nodejs;
    }

    if (!this.nodejs) {
      throw new Error('nodejs-mobile-cordova is not available. Make sure NodeJS Mobile plugin is installed.');
    }
  }

  private async ensureNodeStarted(script = this.scriptName) {
    if (this.nodeStarted) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.ensureNodeModule();
    this.scriptName = script;
    this.startPromise = new Promise<void>((resolve, reject) => {
      try {
        this.nodejs.channel.on('message', (payload: NodeMessage) => this.handleMessage(payload));
        this.nodejs.start(script, () => {
          this.nodeStarted = true;
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
    return this.startPromise;
  }

  private handleMessage(payload: NodeMessage) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    if (payload.kind === 'response' && payload.id) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      this.pending.delete(payload.id);
      if (payload.success) {
        if (payload.result && payload.result.connected !== undefined) {
          this.lastStatus = payload.result as DiodeStatus;
        }
        pending.resolve(payload.result);
      } else {
        pending.reject(new Error(payload.error || 'Unknown Diode error'));
      }
      return;
    }

    if (payload.kind === 'event') {
      const { event, data } = payload;
      if (event === 'log' && data) {
        this.logListeners.forEach((listener) => listener(data as DiodeLogEntry));
      } else if (event === 'ready') {
        this.nodeStarted = true;
        this.startPromise?.then(() => undefined).catch(() => undefined);
      }
      return;
    }
  }

  private async sendCommand<T>(action: string, data?: any): Promise<T> {
    await this.ensureNodeStarted();
    return new Promise<T>((resolve, reject) => {
      const id = `${Date.now()}-${globalRequestCounter++}`;
      this.pending.set(id, { resolve, reject });
      try {
        this.nodejs.channel.send({ id, action, data });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async initialize(options: DiodeInitializeOptions): Promise<DiodeStatus> {
    const status = await this.sendCommand<DiodeStatus>('initialize', options);
    this.lastStatus = status;
    return status;
  }

  async bindPorts(options: BindPortsOptions): Promise<BindResult> {
    const result = await this.sendCommand<BindResult>('bind', options);
    return result;
  }

  async publishPorts(options: PublishPortsOptions): Promise<PublishResult> {
    const result = await this.sendCommand<PublishResult>('publish', options);
    return result;
  }

  async getStatus(): Promise<DiodeStatus> {
    if (this.lastStatus) {
      return this.lastStatus;
    }
    const status = await this.sendCommand<DiodeStatus>('status');
    this.lastStatus = status;
    return status;
  }

  async shutdown(): Promise<void> {
    await this.sendCommand('shutdown');
    this.pending.clear();
    this.lastStatus = null;
  }

  async onLog(callback: (entry: DiodeLogEntry) => void): Promise<LogSubscription> {
    this.logListeners.add(callback);
    return {
      remove: () => {
        this.logListeners.delete(callback);
      },
    };
  }
}

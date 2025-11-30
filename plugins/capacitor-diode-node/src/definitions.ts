export type DiodeProtocol = 'tls' | 'tcp' | 'udp';

export interface DiodeInitializeOptions {
  host?: string;
  port?: number;
  keyLocation?: string;
  dataDir?: string;
  reconnect?: {
    maxRetries?: number;
    retryDelay?: number;
    maxRetryDelay?: number;
    autoReconnect?: boolean;
  };
}

export interface BindPortConfig {
  localPort: number;
  targetPort: number;
  deviceIdHex: string;
  protocol?: DiodeProtocol;
}

export interface PublishPortConfig {
  port: number;
  mode?: 'public' | 'private';
  whitelist?: string[];
}

export interface DiodeStatus {
  connected: boolean;
  host?: string;
  port?: number;
  ethereumAddress?: string;
  keyLocation?: string;
  publishedPorts: Record<string, PublishPortConfig>;
  boundPorts: Record<string, BindPortConfig>;
  lastError?: string | null;
}

export interface BindPortsOptions {
  ports: BindPortConfig[] | Record<string, BindPortConfig>;
}

export interface PublishPortsOptions {
  ports: (number | PublishPortConfig | Record<string, PublishPortConfig | string>)[] | Record<string, PublishPortConfig | string>;
}

export interface BindResult {
  ports: Record<string, BindPortConfig>;
}

export interface PublishResult {
  ports: Record<string, PublishPortConfig>;
}

export interface DiodeLogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export interface LogSubscription {
  remove: () => void;
}

export interface DiodeNodePlugin {
  initialize(options: DiodeInitializeOptions): Promise<DiodeStatus>;
  bindPorts(options: BindPortsOptions): Promise<BindResult>;
  publishPorts(options: PublishPortsOptions): Promise<PublishResult>;
  getStatus(): Promise<DiodeStatus>;
  shutdown(): Promise<void>;
  onLog(callback: (entry: DiodeLogEntry) => void): Promise<LogSubscription>;
}

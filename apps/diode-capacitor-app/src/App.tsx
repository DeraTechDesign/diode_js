import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  BindPortConfig,
  DiodeNode,
  DiodeStatus,
  LogSubscription,
  PublishPortConfig,
} from '@diodejs/capacitor-diode-node';
import './App.css';

type LogRow = { id: number; level: string; message: string };

type BindFormState = {
  localPort: string;
  targetPort: string;
  deviceIdHex: string;
  protocol: BindPortConfig['protocol'];
};

type PublishFormState = {
  port: string;
  mode: PublishPortConfig['mode'];
  whitelist: string;
};

const isNative = Capacitor.isNativePlatform();

function App() {
  const [status, setStatus] = useState<DiodeStatus | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [connectionForm, setConnectionForm] = useState({ host: 'eu2.prenet.diode.io', port: '41046' });
  const [bindForm, setBindForm] = useState<BindFormState>({
    localPort: '3002',
    targetPort: '80',
    deviceIdHex: '',
    protocol: 'tls',
  });
  const [publishForm, setPublishForm] = useState<PublishFormState>({
    port: '8080',
    mode: 'public',
    whitelist: '',
  });

  useEffect(() => {
    let mounted = true;
    let subscription: LogSubscription | null = null;
    DiodeNode.onLog((entry) => {
      if (!mounted) return;
      setLogs((prev) => [{ id: Date.now(), level: entry.level, message: entry.message }, ...prev].slice(0, 80));
    }).then((sub) => {
      subscription = sub;
      if (!mounted) {
        sub.remove();
      }
    });
    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await DiodeNode.getStatus();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleInitialize = async (event: FormEvent) => {
    event.preventDefault();
    if (!isNative) {
      setError('Diode runtime is only available inside a native shell.');
      return;
    }
    setBusyAction('connect');
    setError(null);
    setInfo(null);
    try {
      await DiodeNode.initialize({ host: connectionForm.host, port: Number(connectionForm.port) });
      await refreshStatus();
      setInfo('Connected to Diode network');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const buildBindConfig = (): BindPortConfig | null => {
    const localPort = Number(bindForm.localPort);
    const targetPort = Number(bindForm.targetPort);
    if (!localPort || !targetPort || !bindForm.deviceIdHex) {
      return null;
    }
    return {
      localPort,
      targetPort,
      deviceIdHex: bindForm.deviceIdHex.trim(),
      protocol: bindForm.protocol,
    };
  };

  const handleBind = async (event: FormEvent) => {
    event.preventDefault();
    const config = buildBindConfig();
    if (!config) {
      setError('Please provide local port, target port, and a device ID.');
      return;
    }
    setBusyAction('bind');
    setError(null);
    setInfo(null);
    try {
      await DiodeNode.bindPorts({ ports: [config] });
      await refreshStatus();
      setInfo(`Bound local:${config.localPort} to remote:${config.protocol}:${config.targetPort}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handlePublish = async (event: FormEvent) => {
    event.preventDefault();
    const port = Number(publishForm.port);
    if (!port) {
      setError('Publish port must be a number.');
      return;
    }
    const whitelist = publishForm.whitelist
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    setBusyAction('publish');
    setError(null);
    setInfo(null);
    try {
      await DiodeNode.publishPorts({
        ports: [
          {
            port,
            mode: publishForm.mode,
            whitelist,
          },
        ],
      });
      await refreshStatus();
      setInfo(`Published port ${port} (${publishForm.mode})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleShutdown = async () => {
    setBusyAction('shutdown');
    setError(null);
    setInfo(null);
    try {
      await DiodeNode.shutdown();
      await refreshStatus();
      setInfo('Diode runtime stopped');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const boundPorts = useMemo(() => status?.boundPorts ?? {}, [status]);
  const publishedPorts = useMemo(() => status?.publishedPorts ?? {}, [status]);

  return (
    <div className="App">
      <header className="app-header">
        <div>
          <h1>Diode Node Controller</h1>
          <p>Manage publish/bind flows through the NodeJS Mobile runtime.</p>
        </div>
        <div className={`status-pill ${status?.connected ? 'online' : 'offline'}`}>
          {status?.connected ? 'ONLINE' : 'OFFLINE'}
        </div>
      </header>

      {!isNative && (
        <div className="banner warning">
          Run this build inside an Android emulator/device to access the NodeJS Mobile runtime with OpenSSL support.
        </div>
      )}

      {error && (
        <div className="banner error">
          {error}
        </div>
      )}

      {info && (
        <div className="banner success">
          {info}
        </div>
      )}

      <section className="card-grid">
        <form className="card" onSubmit={handleInitialize}>
          <h2>Connect</h2>
          <label>
            Host
            <input
              value={connectionForm.host}
              onChange={(evt) => setConnectionForm((prev) => ({ ...prev, host: evt.target.value }))}
              placeholder="Server hostname"
            />
          </label>
          <label>
            Port
            <input
              type="number"
              value={connectionForm.port}
              onChange={(evt) => setConnectionForm((prev) => ({ ...prev, port: evt.target.value }))}
            />
          </label>
          <button type="submit" disabled={busyAction === 'connect'}>
            {busyAction === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        <form className="card" onSubmit={handleBind}>
          <h2>Bind Port</h2>
          <label>
            Local Port
            <input
              type="number"
              value={bindForm.localPort}
              onChange={(evt) => setBindForm((prev) => ({ ...prev, localPort: evt.target.value }))}
            />
          </label>
          <label>
            Target Port
            <input
              type="number"
              value={bindForm.targetPort}
              onChange={(evt) => setBindForm((prev) => ({ ...prev, targetPort: evt.target.value }))}
            />
          </label>
          <label>
            Target Device
            <input
              value={bindForm.deviceIdHex}
              onChange={(evt) => setBindForm((prev) => ({ ...prev, deviceIdHex: evt.target.value }))}
              placeholder="0x…"
            />
          </label>
          <label>
            Protocol
            <select
              value={bindForm.protocol}
              onChange={(evt) => setBindForm((prev) => ({ ...prev, protocol: evt.target.value as BindPortConfig['protocol'] }))}
            >
              <option value="tls">TLS</option>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </label>
          <button type="submit" disabled={busyAction === 'bind'}>
            {busyAction === 'bind' ? 'Binding…' : 'Bind'}
          </button>
        </form>

        <form className="card" onSubmit={handlePublish}>
          <h2>Publish Port</h2>
          <label>
            Port
            <input
              type="number"
              value={publishForm.port}
              onChange={(evt) => setPublishForm((prev) => ({ ...prev, port: evt.target.value }))}
            />
          </label>
          <label>
            Mode
            <select
              value={publishForm.mode}
              onChange={(evt) => setPublishForm((prev) => ({ ...prev, mode: evt.target.value as PublishPortConfig['mode'] }))}
            >
              <option value="public">Public</option>
              <option value="private">Private</option>
            </select>
          </label>
          <label>
            Whitelist (comma separated)
            <input
              value={publishForm.whitelist}
              onChange={(evt) => setPublishForm((prev) => ({ ...prev, whitelist: evt.target.value }))}
              placeholder="0xabc…,0xdef…"
            />
          </label>
          <button type="submit" disabled={busyAction === 'publish'}>
            {busyAction === 'publish' ? 'Publishing…' : 'Publish'}
          </button>
        </form>
      </section>

      <section className="card status-card">
        <div className="status-row">
          <div>
            <h3>Node Identity</h3>
            <p className="detail">{status?.ethereumAddress || '–'}</p>
          </div>
          <div className="actions">
            <button onClick={refreshStatus}>Refresh</button>
            <button onClick={handleShutdown} disabled={busyAction === 'shutdown'}>
              {busyAction === 'shutdown' ? 'Stopping…' : 'Shutdown'}
            </button>
          </div>
        </div>
        <div className="status-columns">
          <div>
            <h4>Bound Ports</h4>
            {Object.keys(boundPorts).length === 0 && <p className="detail">No bindings configured.</p>}
            {Object.entries(boundPorts).map(([localPort, config]) => (
              <p key={localPort} className="detail">
                {localPort} › {config.protocol}:{config.targetPort} ({config.deviceIdHex})
              </p>
            ))}
          </div>
          <div>
            <h4>Published Ports</h4>
            {Object.keys(publishedPorts).length === 0 && <p className="detail">No published ports.</p>}
            {Object.entries(publishedPorts).map(([port, config]) => (
              <p key={port} className="detail">
                {port} · {config.mode}{config.whitelist?.length ? ` (${config.whitelist.length} allowed)` : ''}
              </p>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="log-header">
          <h2>Runtime Logs</h2>
          <button onClick={() => setLogs([])}>Clear</button>
        </div>
        <div className="log-view">
          {logs.length === 0 && <p className="detail">No log entries yet.</p>}
          {logs.map((log) => (
            <div key={log.id} className={`log-row ${log.level}`}>
              <span>{log.level.toUpperCase()}</span>
              <code>{log.message}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default App;

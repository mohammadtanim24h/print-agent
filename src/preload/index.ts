import { contextBridge, ipcRenderer } from 'electron';
import { Channel, type AgentInfo, type AppSettings } from '../shared/ipc-contract';

/**
 * The renderer's entire privileged surface. Named methods only — no raw
 * channel strings, no generic invoke passthrough, no ipcRenderer exposure.
 * Every call is re-validated in the main process (schema + sender guard);
 * this bridge is convenience + typing, not the security boundary.
 */
const api = {
  getAgentInfo: (): Promise<AgentInfo> => ipcRenderer.invoke(Channel.GetAgentInfo),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(Channel.GetSettings),
  setLaunchAtLogin: (enabled: boolean): Promise<AppSettings> =>
    ipcRenderer.invoke(Channel.SetLaunchAtLogin, { enabled }),
  hideWindow: (): Promise<void> => ipcRenderer.invoke(Channel.HideWindow),
  quitApp: (): Promise<void> => ipcRenderer.invoke(Channel.QuitApp),
};

contextBridge.exposeInMainWorld('printAgent', api);

export type PrintAgentApi = typeof api;

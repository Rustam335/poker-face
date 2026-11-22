// Narrow bridge between the control window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pokerFace', {
  listCameras: () => ipcRenderer.invoke('cameras:list'),
  startCamera: (cameraId) => ipcRenderer.invoke('sensor:start', cameraId),
  stopCamera: () => ipcRenderer.invoke('sensor:stop'),
  dispatch: (event) => ipcRenderer.send('game:dispatch', event),
  copyOverlayUrl: () => ipcRenderer.invoke('overlay:copy-url'),
  onState: subscribe('state'),
  onFrame: subscribe('frame'),
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("catWorkshopDesktop", {
  minimize: () => ipcRenderer.send("desktop-window-action", "minimize"),
  close: () => ipcRenderer.send("desktop-window-action", "close"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("desktop-toggle-always-on-top"),
  scaleWindow: (deltaY, screenX, screenY) => ipcRenderer.invoke("desktop-window-scale", { deltaY, screenX, screenY }),
  openRecipesInBrowser: () => ipcRenderer.invoke("open-recipes-in-browser"),
  beginWindowDrag: (screenX, screenY) => ipcRenderer.send("desktop-window-drag", "begin", { screenX, screenY }),
  moveWindowDrag: (screenX, screenY) => ipcRenderer.send("desktop-window-drag", "move", { screenX, screenY }),
  endWindowDrag: () => ipcRenderer.send("desktop-window-drag", "end"),
});

window.addEventListener("DOMContentLoaded", () => {
  if (window.location.pathname !== "/recipes.html") document.documentElement.classList.add("desktop-shell");
});

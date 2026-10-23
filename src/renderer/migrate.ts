/** Settings saved while the app was called Y3D ("y3d.*" localStorage keys) carry over to "yddd.*" once. Imported first. */
for (let i = localStorage.length - 1; i >= 0; i--) {
  const key = localStorage.key(i);
  if (!key?.startsWith("y3d.")) continue;
  const to = "yddd." + key.slice(4);
  if (localStorage.getItem(to) === null) localStorage.setItem(to, localStorage.getItem(key)!);
  localStorage.removeItem(key);
}
export {};

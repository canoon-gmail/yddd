/** Small DOM / text helpers shared by the app controller and its parts. */
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const fmt = (n: number) => String(Math.round(n * 100) / 100);
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const isPro = () => document.body.classList.contains("pro");

/**
 * The documents an HTML page runs as: the page itself, held in a wrapper.
 *
 * Both are sandboxed srcdoc frames on opaque origins. Each layer stops
 * something the others do not, and each was proven in Chrome by a page trying
 * every way out (artifact.chrome.test.ts):
 *
 *  - The sandbox (scripts only) stops popups, forms, downloads' windows, and
 *    navigating the dashboard or any frame but the page's own.
 *  - The page's policy, first in its head, allows no network: no fetch, no
 *    socket, no external script, style, image, font, object or frame.
 *  - The wrapper's policy says what the page's frame may load: about: and
 *    nothing else. A frame's navigation is checked against its parent's
 *    policy, so a page sending itself elsewhere (location, a link, a meta
 *    refresh) is refused before any request goes; and since a srcdoc frame
 *    inherits its parent's policy, the page can only narrow it, never widen it.
 *  - Trusted Types and the guard script, which run before the page's own,
 *    keep the page from making a <link>, <meta>, <iframe>, <form> or
 *    <script>, which no policy covers: `<link rel=prerender>` makes a real
 *    request whatever the policy says, and a new frame is a fresh realm. The
 *    page's own markup is held to the same at write time (htmlpage.ts).
 *
 * What still leaves: Chrome opens a connection (a DNS lookup and a TCP
 * connect, no request) to the host a navigation is aimed at, before it checks
 * the policy. No path, query or body is sent. An opaque frame has no
 * Navigation API to cancel the navigation earlier, so this one is held at
 * write time only.
 */

/** What a page may load: nothing from the network. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The page's own policy on top: no frames at all, and HTML only through the guard. */
export const PAGE_GUARD_CSP = `${PAGE_CSP}; frame-src 'none'; child-src 'none'; require-trusted-types-for 'script'; trusted-types default`;

/** The wrapper's: what the page's frame may navigate to, which is about: alone. */
export const WRAPPER_CSP = `${PAGE_CSP}; frame-src about:`;

/**
 * What runs before anything the page wrote. Trusted Types send every string
 * the page turns into HTML through one policy, which refuses the elements no
 * Content Security Policy governs; the element factories refuse them too, and
 * are frozen; XSLT, which can build elements from data, is taken away.
 */
export const GUARD_SCRIPT = String.raw`(function(){
var inMarkup=/<\/?(link|meta|iframe|frame|frameset|object|embed|base|form|portal|fencedframe|script)(?![\w-])/i;
var isTag=/^(link|meta|iframe|frame|frameset|object|embed|base|form|portal|fencedframe|script)$/i;
function refuse(what){throw new TypeError("A KOS page cannot make "+what+": it has no network to use it.")}
trustedTypes.createPolicy("default",{createHTML:function(s){if(inMarkup.test(s)||/xsl:/i.test(s))refuse("that markup");return s},createScript:function(){refuse("a script")},createScriptURL:function(){refuse("a script URL")}});
var make=Document.prototype.createElement,makeNS=Document.prototype.createElementNS;
Object.defineProperty(Document.prototype,"createElement",{value:function(n,o){if(isTag.test(String(n)))refuse("<"+n+">");return make.call(this,n,o)},writable:false,configurable:false});
Object.defineProperty(Document.prototype,"createElementNS",{value:function(ns,n,o){if(isTag.test(String(n).split(":").pop()))refuse("<"+n+">");return makeNS.call(this,ns,n,o)},writable:false,configurable:false});
Object.defineProperty(window,"XSLTProcessor",{value:undefined,writable:false,configurable:false});
})();`;

/** A page's own head and body, from a whole document or a fragment. */
export function splitHtml(html: string): { head: string; body: string } {
  const text = html.replace(/<!doctype[^>]*>/i, "").replace(/<\/?html[^>]*>/gi, "");
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(text);
  const rest = head ? text.slice(0, head.index) + text.slice(head.index + head[0].length) : text;
  const body = /<body[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(rest);
  return { head: head?.[1] ?? "", body: body ? body[1]! : rest };
}

/** The tokens as one :root rule, for the page and for a change of theme. */
export function tokenRule(tokens: Record<string, string>, mode: "light" | "dark"): string {
  return `:root{--scheme:${mode};${Object.entries(tokens)
    .map(([name, value]) => `${name}:${value.replace(/[;{}<]/g, "")}`)
    .join(";")}}`;
}

/**
 * The page's side of window.kos. Calls go to the shell as messages and come
 * back as promises; the shell answers only this frame, and the server checks
 * each call against what the page declared. Errors the page throws are told
 * to the shell, which shows them with a way to ask KOS to fix the page.
 */
export const BRIDGE_SCRIPT = `(function(){
var seq=0,waiting={},themeFns=[],refreshFns=[],mode=document.documentElement.dataset.mode||"dark";
function call(method,args){return new Promise(function(resolve,reject){var id=++seq;waiting[id]={resolve:resolve,reject:reject};top.postMessage({__kos:"call",id:id,method:method,args:args},"*");});}
function report(message){try{top.postMessage({__kos:"error",message:String(message).slice(0,2000)},"*");}catch(_){}}
addEventListener("message",function(e){
if(e.source!==top)return;var m=e.data||{};
if(m.__kos==="reply"){var w=waiting[m.id];if(!w)return;delete waiting[m.id];if(m.error)w.reject(new Error(m.error));else w.resolve(m.result);}
else if(m.__kos==="theme"){mode=m.mode;document.documentElement.dataset.mode=m.mode;var s=document.getElementById("kos-tokens");if(s)s.textContent=m.rule;themeFns.forEach(function(f){try{f(m.mode)}catch(err){report(err&&err.message||err)}});}
});
addEventListener("error",function(e){report(e.message||"The page hit an error")});
addEventListener("unhandledrejection",function(e){var r=e.reason;report(r&&r.message?r.message:String(r))});
var kos={
query:function(sql,params){return call("query",{sql:sql,params:params})},
write:function(table,op,values,key){return call("write",{table:table,op:op,values:values,key:key}).then(function(r){refreshFns.forEach(function(f){try{f()}catch(err){report(err&&err.message||err)}});return r})},
files:Object.freeze({read:function(path){return call("file",{path:path})}}),
ask:function(text){return call("ask",{text:String(text)})},
onTheme:function(f){themeFns.push(f)},
refresh:function(f){refreshFns.push(f)}
};
Object.defineProperty(kos,"theme",{get:function(){return mode},enumerable:true});
Object.defineProperty(window,"kos",{value:Object.freeze(kos)});
})();`;

/** Keep a page's script from ending ours early or reading as markup. */
const scriptSafe = (code: string): string => code.replace(/<\/script/gi, "<\\/script");

export interface PageDocumentInput {
  html: string;
  tokens: Record<string, string>;
  mode: "light" | "dark";
  css: string;
  /** The text of each library the page named, already fetched. */
  libraries: string[];
}

export function pageDocument({ html, tokens, mode, css, libraries }: PageDocumentInput): string {
  const { head, body } = splitHtml(html);
  return [
    "<!doctype html>",
    `<html data-mode="${mode}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_GUARD_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<script>${GUARD_SCRIPT}</script>`,
    `<style id="kos-tokens">${tokenRule(tokens, mode)}</style>`,
    `<style>${css.replace(/<\/style/gi, "")}</style>`,
    `<script>${BRIDGE_SCRIPT}</script>`,
    ...libraries.map((code) => `<script>${scriptSafe(code)}</script>`),
    head,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The wrapper the dashboard frames: the page's frame and nothing else, under a
 * policy that lets that frame hold about: documents only. Its one script tells
 * the dashboard when the page's frame loads a second time, which is the page
 * having tried to leave.
 */
export function wrapperDocument(page: string): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${WRAPPER_CSP}">`,
    "<style>html,body{margin:0;height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style>",
    "</head><body>",
    `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attr(page)}"></iframe>`,
    '<script>(function(){var f=document.querySelector("iframe"),n=0;f.addEventListener("load",function(){if(++n>1)top.postMessage({__kos:"left"},"*")})})()</script>',
    "</body></html>",
  ].join("");
}

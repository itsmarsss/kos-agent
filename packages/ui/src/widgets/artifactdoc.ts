/**
 * The document an HTML page runs as, inside its sandboxed frame.
 *
 * What the agent wrote goes in last, after what holds it: a Content Security
 * Policy that allows no network at all (no fetch, no external image, font,
 * script or stylesheet, no form submission), KOS's tokens and stylesheet so
 * the page reads as KOS, the `window.kos` bridge, and the libraries the page
 * named, inlined, since the frame cannot load them. The policy comes first
 * and a page can only add a stricter one: a second policy narrows, never
 * widens.
 */

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
function call(method,args){return new Promise(function(resolve,reject){var id=++seq;waiting[id]={resolve:resolve,reject:reject};parent.postMessage({__kos:"call",id:id,method:method,args:args},"*");});}
function report(message){try{parent.postMessage({__kos:"error",message:String(message).slice(0,2000)},"*");}catch(_){}}
addEventListener("message",function(e){
if(e.source!==parent)return;var m=e.data||{};
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
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`,
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
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

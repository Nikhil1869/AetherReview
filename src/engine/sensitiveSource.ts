/** High-confidence credential formats and containers. Filtering happens before
 * sending either the patch, its surrounding context, or repository preferences. */
const privateContainer =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.aetherreview|\.kube)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*\.(?:pem|p12|pfx|key|jks|keystore))$/i;
const credential =
  /-----\s*(?:BEGIN|END) (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|glpat-[a-zA-Z0-9_-]{16,}|sk-(?:proj-)?[a-zA-Z0-9_-]{24,}|AKIA[A-Z0-9]{16}|AIza[a-zA-Z0-9_-]{35}|xox[baprs]-[a-zA-Z0-9-]{16,})\b/;
const literalSecret =
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s$<>{}]{8,}["']/i;

export function sensitiveText(text: string): boolean {
  return credential.test(text) || literalSecret.test(text);
}
export function sensitivePath(path: string): boolean {
  return privateContainer.test(path.replaceAll("\\", "/")) || sensitiveText(path);
}

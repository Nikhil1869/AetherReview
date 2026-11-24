/** Portable repository path suitable for lookups, display and hidden markers. */
export function safeSourcePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length <= 4096 &&
    !/[\\:]|-->/.test(path) &&
    !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    path.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git")
  );
}

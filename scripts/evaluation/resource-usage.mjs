import process from "node:process";
import { writeFileSync } from "node:fs";
process.on("exit", () => {
  const { maxRSS, userCPUTime, systemCPUTime } = process.resourceUsage();
  writeFileSync(
    process.env.AETHER_EVAL_RESOURCE,
    JSON.stringify({ peakRssKiB: maxRSS, userCpuUs: userCPUTime, systemCpuUs: systemCPUTime }),
  );
});

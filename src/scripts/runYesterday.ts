import { generateDailySummary } from "../generateDailySummary";

const yesterday = new Date(
  Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() - 1
  )
);

generateDailySummary(yesterday);

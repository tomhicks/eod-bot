import { generateDailySummary } from "../generateDailySummary";

const randomDate = new Date();
randomDate.setDate(randomDate.getDate() - Math.floor(Math.random() * 30));

generateDailySummary(randomDate);

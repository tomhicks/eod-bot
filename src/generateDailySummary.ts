import * as fs from "fs";
import * as path from "path";
import { DailySummaryGenerator } from "./DailySummaryGenerator";

export async function generateDailySummary(
  dateArg?: Date,
  skipLLM: boolean = false
) {
  const date = dateArg || new Date(); // Use the provided date or default to today

  const generator = new DailySummaryGenerator();

  try {
    const { activities, response } = await generator.generateSummary(
      date,
      skipLLM
    );

    // Create the output directory if it doesn't exist
    const outputDir = path.resolve(__dirname, "output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    // Format the date to ISO8601 and use it as the base filename
    let baseFilename = `${date.toISOString().split("T")[0]}`;
    let counter = 1;
    let jsonFilename = `${baseFilename}.${counter}.json`;
    let mdFilename = `${baseFilename}.${counter}.md`;
    let jsonFilePath = path.join(outputDir, jsonFilename);
    let mdFilePath = path.join(outputDir, mdFilename);

    while (fs.existsSync(jsonFilePath) || fs.existsSync(mdFilePath)) {
      counter++;
      jsonFilename = `${baseFilename}.${counter}.json`;
      mdFilename = `${baseFilename}.${counter}.md`;
      jsonFilePath = path.join(outputDir, jsonFilename);
      mdFilePath = path.join(outputDir, mdFilename);
    }

    // Write the summary data to the JSON file
    const jsonData = {
      activities,
      response,
    };
    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 2));

    // Write the summary data to the Markdown file
    fs.writeFileSync(mdFilePath, response.trim());

    console.log(
      `Summary generated and saved to ${jsonFilePath} and ${mdFilePath}`
    );
  } catch (error) {
    console.error("Error generating summary:", error);
  }
}

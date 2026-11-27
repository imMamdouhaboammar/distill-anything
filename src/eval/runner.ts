import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BudgetLedger } from "../core/budget";
import { callStructuredLlm, callTextLlm } from "../core/llm";

export const EvalTaskSchema = z.object({
  id: z.string(),
  type: z.enum(["positive", "negative_anti_trigger"]),
  prompt: z.string().min(20),
  expectedBehavior: z.string().min(20),
  forbiddenPatternSignal: z.string().optional(),
});

export const EvalSuiteSchema = z.object({
  skillName: z.string(),
  tasks: z.array(EvalTaskSchema).min(1),
});

export type EvalTask = z.infer<typeof EvalTaskSchema>;
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

const EvalJudgeSchema = z.object({
  controlScore: z.number().int().min(1).max(5),
  treatmentScore: z.number().int().min(1).max(5),
  treatmentPassed: z.boolean(),
  reasoning: z.string(),
});

export interface EvalResult {
  skillName: string;
  positiveWins: number;
  positiveTotal: number;
  negativePasses: number;
  negativeTotal: number;
  passedShipCriteria: boolean;
  details: Array<{
    taskId: string;
    type: EvalTask["type"];
    controlScore: number;
    treatmentScore: number;
    treatmentPassed: boolean;
    reasoning: string;
  }>;
}

function loadSkillContext(skillDir: string): string {
  const skillMd = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const patternsDir = join(skillDir, "references/patterns");
  const patternFiles = existsSync(patternsDir)
    ? readdirSync(patternsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => `### ${f}\n${readFileSync(join(patternsDir, f), "utf8")}`)
        .join("\n\n")
    : "";
  return `${skillMd}\n\n${patternFiles}`;
}

/** Runs Control (A) vs Treatment (B) evaluation on a compiled skill directory. */
export async function runEvalSuite(params: {
  suite: EvalSuite;
  skillDir: string;
  targetModelId: string;
  judgeModelId: string;
  maxBudgetUsd: number;
}): Promise<EvalResult> {
  const budget = new BudgetLedger(params.maxBudgetUsd);
  const skillContext = loadSkillContext(params.skillDir);

  const details: EvalResult["details"] = [];
  let positiveWins = 0;
  let positiveTotal = 0;
  let negativePasses = 0;
  let negativeTotal = 0;

  for (const task of params.suite.tasks) {
    const control = await callTextLlm({
      stage: "novelty_baseline",
      modelId: params.targetModelId,
      prompt: task.prompt,
      maxOutputTokens: 1200,
      budget,
    });

    const treatment = await callTextLlm({
      stage: "novelty_baseline",
      modelId: params.targetModelId,
      system: `You have the following Agent Skill available. Apply its patterns ONLY when trigger conditions match and NO anti-triggers apply. If no pattern applies or an anti-trigger matches, ignore the playbook and answer normally using standard engineering best practices.\n\n${skillContext}`,
      prompt: task.prompt,
      maxOutputTokens: 1200,
      budget,
    });

    const judgePrompt = `Evaluate Control (A, no skill) vs Treatment (B, with skill).
Task Type: ${task.type}
Task Prompt: ${task.prompt}
Expected Behavior: ${task.expectedBehavior}
${task.forbiddenPatternSignal ? `Forbidden Over-Engineering Signal: ${task.forbiddenPatternSignal}` : ""}

--- CONTROL (A) ---
${control.text}

--- TREATMENT (B) ---
${treatment.text}`;

    const { object: score } = await callStructuredLlm({
      stage: "novelty_judge",
      modelId: params.judgeModelId,
      prompt: judgePrompt,
      schema: EvalJudgeSchema,
      maxOutputTokens: 400,
      budget,
    });

    if (task.type === "positive") {
      positiveTotal += 1;
      if (score.treatmentScore > score.controlScore && score.treatmentPassed) {
        positiveWins += 1;
      }
    } else {
      negativeTotal += 1;
      if (score.treatmentPassed) {
        negativePasses += 1;
      }
    }

    details.push({
      taskId: task.id,
      type: task.type,
      controlScore: score.controlScore,
      treatmentScore: score.treatmentScore,
      treatmentPassed: score.treatmentPassed,
      reasoning: score.reasoning,
    });
  }

  const passedShipCriteria =
    (positiveTotal === 0 || positiveWins >= Math.ceil((positiveTotal * 2) / 3)) &&
    negativePasses === negativeTotal;

  return {
    skillName: params.suite.skillName,
    positiveWins,
    positiveTotal,
    negativePasses,
    negativeTotal,
    passedShipCriteria,
    details,
  };
}

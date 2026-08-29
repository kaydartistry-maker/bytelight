// Skill scanning services — extracted from hooks.ts

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getBytelightConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Skill scanning — parse frontmatter from AGENT_CWD/.claude/skills/*/SKILL.md
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  dirName: string;
}

let skillsStructuredCache: { skills: SkillInfo[]; scannedAt: number } | null = null;
let skillsSummaryCache: { summaries: string; scannedAt: number } | null = null;
const SKILLS_CACHE_MS = 60 * 1000; // Re-scan every 60s

/** Scan skills directory and return structured data. Used by commands.ts for registry. */
export function scanSkills(): SkillInfo[] {
  const config = getBytelightConfig();
  const skillsDir = join(config.agent.cwd, '.claude', 'skills');

  if (skillsStructuredCache && (Date.now() - skillsStructuredCache.scannedAt) < SKILLS_CACHE_MS) {
    return skillsStructuredCache.skills;
  }

  try {
    if (!existsSync(skillsDir)) return [];

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skills: SkillInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;

      const fm = frontmatterMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (!nameMatch) continue;

      skills.push({
        name: nameMatch[1].trim(),
        description: descMatch ? descMatch[1].trim() : '',
        path: skillFile.replace(/\\/g, '/'),
        dirName: entry.name,
      });
    }

    skillsStructuredCache = { skills, scannedAt: Date.now() };
    return skills;
  } catch (error) {
    console.warn('[Skills] Failed to scan skills:', (error as Error).message);
    return [];
  }
}

/** Formatted skill summaries for orientation context injection. */
export function scanSkillSummaries(): string {
  if (skillsSummaryCache && (Date.now() - skillsSummaryCache.scannedAt) < SKILLS_CACHE_MS) {
    return skillsSummaryCache.summaries;
  }

  const skills = scanSkills();
  if (skills.length === 0) return '';

  const lines = ['SKILLS (read with Bash cat when needed):'];
  for (const skill of skills) {
    const desc = skill.description.length > 150
      ? skill.description.substring(0, 150) + '...'
      : skill.description;
    lines.push(`- ${skill.name}: ${desc}`);
    lines.push(`  Path: ${skill.path}`);
  }

  const result = lines.join('\n');
  skillsSummaryCache = { summaries: result, scannedAt: Date.now() };
  return result;
}

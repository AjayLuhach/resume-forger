/**
 * Base AI Provider
 *
 * Shared logic for all AI providers: pipeline orchestration,
 * response expansion, and JSON parsing.
 *
 * Prompts live in prompts.js — edit them there.
 *
 * To add a new provider, extend this class and implement:
 *   - invoke(systemPrompt, messages, stepName) → raw text response
 *   - getModelLabel() → display name for logging
 *
 * See bedrock.js or gemini.js for examples.
 */

import { scoreResume } from "../pipeline/ats-scorer.js";
import { buildSkillLine } from "../pipeline/skill-line.js";
import { logKeywordGaps, logResumeHistory } from "../logging.js";
import { displayAnalysis, displayScore } from "../display.js";
import { logContactDetails } from "../outreach/contact-logger.js";
import * as strictPrompts from "../pipeline/prompts.js";
import * as atsMaxPrompts from "../pipeline/prompts-ats-max.js";
import { parseLooseJSON, stripControlChars } from "./json-repair.js";
import { sanitizeJobDescription } from "../clipboard.js";

export class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * Override in subclass: send prompt to AI and return raw text
   * @param {string} systemPrompt
   * @param {Array} messages - [{role: 'user', content: '...'}]
   * @param {string} stepName - 'analysis' or 'rewrite'
   * @returns {Promise<string>} raw text response
   */
  async invoke(systemPrompt, messages, stepName) {
    throw new Error(`${this.name}: invoke() not implemented`);
  }

  /**
   * Override in subclass: return display label for current model
   */
  getModelLabel() {
    return this.name;
  }

  /**
   * Override in subclass: return the model ID used for logging
   */
  getModelId() {
    return this.name;
  }

  // ── JSON Parsing ──

  /**
   * Parse a model response into an object.
   *
   * Repairs (fences, surrounding prose, raw control characters inside string
   * literals, truncation) live in json-repair.js — see that file for why each
   * one exists. Strict-valid JSON still takes the fast path.
   */
  parseJSON(response, step = "") {
    return parseLooseJSON(response, step);
  }

  // ── Response Expansion ──

  expandAnalysisResponse(abbreviated) {
    return {
      exactMatch: abbreviated.exact || [],
      coreSkills: abbreviated.coreSkills || [],
      canClaim: abbreviated.claim || [],
      cannotClaim: abbreviated.no || [],
      keyPhrases: abbreviated.phrases || [],
      missing: abbreviated.miss || [],
      jdLang: abbreviated.jdLang || null,
      jdYears: abbreviated.jdYears || null,
      jdTitle: abbreviated.jdTitle || null,
      jdCompany: abbreviated.jdCompany || null,
      companySummary: abbreviated.companySummary || null,
      requiredSkills: abbreviated.requiredSkills || [],
      niceToHave: abbreviated.niceToHave || [],
      jobType: abbreviated.jobType || "Full-time",
      salary: abbreviated.salary || null,
      contact: abbreviated.contact || {
        name: null,
        email: null,
        phone: null,
        link: null,
        applyUrl: null,
        instructions: null,
      },
      candidateTech: abbreviated.candidateTech || "Full Stack",
      relevantProjects: abbreviated.relevantProjects || [],
      personalProjects: abbreviated.personalProjects || [],
      // ATS_MAX fields (no-op for strict mode — these just won't exist)
      gapSkills: abbreviated.gapSkills || [],
      compensateWith: abbreviated.compensateWith || {},
    };
  }

  expandRewriteResponse(abbreviated, resumeData) {
    const personalProjects = {};
    const projectDescriptions = {};

    (resumeData.projects || []).forEach((project) => {
      const key = project.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      personalProjects[project.name] = abbreviated[key] || "";
      projectDescriptions[key] = abbreviated[key] || "";
    });

    const projectsUsed = abbreviated.projectsUsed || [];
    const phrasesUsed = abbreviated.phrasesUsed || [];
    const coverLetter = abbreviated.coverLetter || "";

    return {
      title: abbreviated.title || "Software Developer",
      summary: abbreviated.sum || "",
      bullets: abbreviated.bul || [],
      skills: abbreviated.skl || "",
      projects: personalProjects,
      projectsUsed,
      phrasesUsed,
      coverLetter,
      ...projectDescriptions,
    };
  }

  // ── Main Pipeline ──

  /**
   * Full tailoring pipeline: analyze JD → rewrite resume → score
   * @param {string} rawJobDescription - pasted JD; sanitized before use
   * @param {Object} resumeData
   * @param {Object} [options]
   * @param {string} [options.mode='strict'] - 'strict' or 'ats_max'
   * @returns {Object} tailored resume with ATS score
   */
  async tailorResume(rawJobDescription, resumeData, options = {}) {
    const mode = options.mode || 'strict';
    const prompts = mode === 'ats_max' ? atsMaxPrompts : strictPrompts;

    // JDs are pasted straight off career sites, so they arrive with two kinds
    // of garbage: stray control characters (\r, \v, \f, C1 junk) that the
    // model echoes back into string values and breaks the response JSON, and
    // job-board UI chrome ("Tailor my resume", "Help me stand out") that reads
    // as instructions rather than data. Strip both before prompt-building.
    const jobDescription = sanitizeJobDescription(
      stripControlChars(String(rawJobDescription ?? '')),
    );

    const systemPrompt = prompts.buildSystemPrompt(resumeData);
    const resumeContext = prompts.buildResumeContext(resumeData);

    // ── Step 1: Analysis ──
    const modeLabel = mode === 'ats_max' ? ' [ATS_MAX]' : '';
    console.log(`\n🔍 STEP 1: Analyzing JD keywords...${modeLabel} [${this.getModelLabel()}]`);

    const analysisUserPrompt = `${resumeContext}\n\n${prompts.buildAnalysisPrompt(jobDescription, resumeData)}`;
    const analysisMessages = [{ role: "user", content: analysisUserPrompt }];

    const analysisText = await this.invoke(
      systemPrompt,
      analysisMessages,
      "analysis",
    );
    const analysisRaw = this.parseJSON(analysisText, "Step 1 - Analysis");
    const analysis = this.expandAnalysisResponse(analysisRaw);
    displayAnalysis(analysis);

    const jobTitle = jobDescription.split("\n")[0];
    logKeywordGaps(jobTitle, analysis);
    logContactDetails(analysis.contact, {
      title: analysis.jdTitle,
      company: analysis.jdCompany,
    });

    // ── Step 2: Rewrite ──
    console.log(`\n✍️  STEP 2: Rewriting resume...${modeLabel} [${this.getModelLabel()}]`);

    const resumeContextForRewrite = prompts.buildResumeContextForRewrite(
      resumeData,
      analysis,
    );
    const rewriteUserPrompt = prompts.buildRewritePrompt(
      jobDescription,
      analysisRaw,
      resumeData,
      resumeContextForRewrite,
    );
    const rewriteMessages = [{ role: "user", content: rewriteUserPrompt }];

    const rewriteText = await this.invoke(
      systemPrompt,
      rewriteMessages,
      "rewrite",
    );
    const rewriteRaw = this.parseJSON(rewriteText, "Step 2 - Rewrite");
    const rewritten = this.expandRewriteResponse(rewriteRaw, resumeData);

    // Retention + JD ordering for the skills line. Deliberately deterministic
    // and applied BEFORE scoring, so the scorer reads the line that is printed.
    // A narrow JD used to be able to evict the candidate's core stack outright
    // — see services/pipeline/skill-line.js.
    rewritten.skills = buildSkillLine({
      skills: rewritten.skills,
      jobDescription,
      resumeData,
      analysis,
      // The page's own claims pin the skills line — see skill-line.js.
      pageText: [
        rewritten.summary,
        ...(rewritten.bullets || []),
        ...Object.values(rewritten.projects || {}),
      ].join(' \n '),
    });

    // ── Step 3: Score (Deterministic) ──
    const score = scoreResume(analysis, rewritten, resumeData);

    if (
      !rewritten.summary ||
      !Array.isArray(rewritten.bullets) ||
      rewritten.bullets.length < 4
    ) {
      throw new Error("Invalid rewrite output");
    }

    logResumeHistory(analysis, rewritten, score, this.getModelId());
    displayScore(score);

    return {
      ...rewritten,
      mode,
      jdTitle: analysis.jdTitle || null,
      jdCompany: analysis.jdCompany || null,
      jobType: analysis.jobType || "Full-time",
      salary: analysis.salary || null,
      contact: analysis.contact,
      atsScore: score,
      phrases: analysis.keyPhrases || [],
    };
  }
}

export default BaseProvider;

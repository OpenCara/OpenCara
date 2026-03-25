/**
 * Detects suspicious patterns in repository-provided prompts that may
 * indicate prompt injection attempts.
 *
 * The agent still proceeds with the review but reports findings to the server
 * and includes a warning flag in the result.
 */

export interface SuspiciousPattern {
  /** The pattern name/category. */
  name: string;
  /** Human-readable description of what was detected. */
  description: string;
  /** The matched text (truncated for safety). */
  matchedText: string;
}

export interface PromptGuardResult {
  /** Whether suspicious patterns were detected. */
  suspicious: boolean;
  /** List of detected patterns. */
  patterns: SuspiciousPattern[];
}

interface PatternRule {
  name: string;
  description: string;
  regex: RegExp;
}

/**
 * Patterns that indicate prompt injection attempts in repo-provided prompts.
 * Each regex uses case-insensitive matching.
 */
const SUSPICIOUS_PATTERNS: PatternRule[] = [
  {
    name: 'instruction_override',
    description: 'Attempts to override or ignore previous instructions',
    regex:
      /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|above|prior|system|original)\b.{0,30}\b(instructions?|prompt|rules?|guidelines?)\b/i,
  },
  {
    name: 'role_hijack',
    description: 'Attempts to reassign the AI role',
    regex: /\b(you are now|act as|pretend to be|assume the role|your new role)\b/i,
  },
  {
    name: 'command_execution',
    description: 'Attempts to execute shell commands',
    regex: /\b(run|execute|eval|exec)\b.{0,20}\b(command|shell|bash|sh|cmd|terminal|script)\b/i,
  },
  {
    name: 'shell_injection',
    description: 'Shell injection patterns (backticks, $(), pipes to shell)',
    regex: /`[^`]*`|\$\([^)]+\)|\|\s*(bash|sh|zsh|cmd|powershell)\b/i,
  },
  {
    name: 'data_exfiltration',
    description: 'Attempts to extract or leak sensitive data',
    regex:
      /\b(send|post|upload|exfiltrate|leak|transmit)\b.{0,30}\b(api[_\s]?key|token|secret|credential|password|env)\b/i,
  },
  {
    name: 'output_manipulation',
    description: 'Attempts to force specific review output',
    regex:
      /\b(always\s+approve|always\s+APPROVE|output\s+only|respond\s+with\s+only|your\s+response\s+must\s+be)\b/i,
  },
  {
    name: 'encoded_payload',
    description: 'Base64 or hex-encoded payloads that may hide instructions',
    regex: /\b(base64|atob|btoa)\b.{0,20}(decode|encode)|(\\x[0-9a-f]{2}){4,}/i,
  },
  {
    name: 'hidden_instructions',
    description: 'Zero-width or invisible characters used to hide instructions',
    // Zero-width space, zero-width non-joiner, zero-width joiner, left-to-right/right-to-left marks
    // eslint-disable-next-line no-misleading-character-class
    regex: /[\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF]{3,}/,
  },
];

/** Maximum length of matched text to include in report. */
const MAX_MATCH_LENGTH = 100;

/**
 * Scan a repository-provided prompt for suspicious patterns.
 */
export function detectSuspiciousPatterns(prompt: string): PromptGuardResult {
  const patterns: SuspiciousPattern[] = [];

  for (const rule of SUSPICIOUS_PATTERNS) {
    const match = rule.regex.exec(prompt);
    if (match) {
      patterns.push({
        name: rule.name,
        description: rule.description,
        matchedText: match[0].slice(0, MAX_MATCH_LENGTH),
      });
    }
  }

  return {
    suspicious: patterns.length > 0,
    patterns,
  };
}

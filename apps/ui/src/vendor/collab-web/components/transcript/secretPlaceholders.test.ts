import { describe, expect, test } from "vitest";
import { renderStreamingMarkdown } from "./Markdown";

/** The transcript's markup for a whole text, as a finished message gets it. */
const render = (text: string): string => renderStreamingMarkdown(text, { source: "", html: "" }).html;

const PLACEHOLDER = "$$AMOJWTSECRET_2XUBD7NWOZ1U:L$$";

describe("Hide Secrets placeholders in the transcript", () => {
  test("a placeholder in a sentence or on its own line is a lock and the secret's name, not an equation", () => {
    for (const text of [`Set it to ${PLACEHOLDER} please.`, PLACEHOLDER, `Here:\n\n${PLACEHOLDER}\n\nDone.`]) {
      const html = render(text);
      expect(html).toContain('<span class="tr-secret"');
      expect(html).toContain("🔒 AMOJWTSECRET</span>");
      expect(html).not.toContain("katex");
      expect(html).not.toContain("<math");
    }
    // A secret saved without a name has the code alone.
    expect(render("Use $$2XUBD7NWOZ1U$$ there.")).toContain("🔒 secret</span>");
  });

  test("code keeps a placeholder as written, and real equations are still typeset", () => {
    expect(render(`\`echo ${PLACEHOLDER}\``)).toContain(`echo ${PLACEHOLDER}`);
    // A highlighted block is split into spans: its text, without them, keeps the placeholder.
    const block = render(`\`\`\`bash\ngh secret set X --body "${PLACEHOLDER}"\n\`\`\``);
    expect(block.replace(/<[^>]+>/g, "")).toContain(PLACEHOLDER);
    expect(block).not.toContain("tr-secret");
    expect(render("The area is $$x_1^2$$ here.")).toContain("katex");
    expect(render("$$\nE = mc^2\n$$")).toContain('display="block"');
  });
});

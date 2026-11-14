import { describe, expect, it } from "vitest";
import { renderTemplate, UnknownVariableError } from "../src/engine/templating.js";

describe("renderTemplate", () => {
  const vars = { assistant_name: "Ava", company_name: "Acme Co." };

  it("replaces every {{var}}, including repeats and inner whitespace", () => {
    expect(renderTemplate("I'm {{assistant_name}} at {{ company_name }}. Yes, {{assistant_name}}.", vars)).toBe(
      "I'm Ava at Acme Co.. Yes, Ava.",
    );
  });

  it("leaves text without placeholders alone", () => {
    expect(renderTemplate("Hello there.", vars)).toBe("Hello there.");
  });

  it("does not re-render placeholders that appear inside a variable's value", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "x" })).toBe("{{b}}");
  });

  it("throws, naming the variable, when one is not defined", () => {
    expect(() => renderTemplate("Hi {{caller_name}}", vars)).toThrow(UnknownVariableError);
    expect(() => renderTemplate("Hi {{caller_name}}", vars)).toThrow(/caller_name/);
  });
});

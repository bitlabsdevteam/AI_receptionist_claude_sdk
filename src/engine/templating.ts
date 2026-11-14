/** Thrown when a template names a variable that is not defined. Spoken text must never contain a raw `{{placeholder}}`. */
export class UnknownVariableError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Template uses undefined variable "${variable}"`);
    this.name = "UnknownVariableError";
    this.variable = variable;
  }
}

/** Replaces each `{{name}}` with the variable's value, in a single pass. */
export function renderTemplate(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (value === undefined) throw new UnknownVariableError(name);
    return value;
  });
}

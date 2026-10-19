import { defineRule } from "vite-plus/lint/plugins";

import type { ESTree } from "vite-plus/lint/plugins";

const isEffectGen = (node: ESTree.Node | null | undefined): node is ESTree.CallExpression => {
  if (node?.type !== "CallExpression") return false;
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Effect" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "gen"
  );
};

// `Effect.gen(function* () {...})`, also with `.pipe(...)` after it
const isGenBody = (node: ESTree.Node) => {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  return (
    isEffectGen(node) ||
    (callee.type === "MemberExpression" &&
      callee.computed === false &&
      callee.property.type === "Identifier" &&
      callee.property.name === "pipe" &&
      isEffectGen(callee.object))
  );
};

/**
 * Inline anonymous generators may use Effect.gen. A named function whose whole body is Effect.gen
 * uses Effect.fn, which names the span and keeps the call site in errors.
 */
export const preferEffectFnRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Allow anonymous Effect.gen generators and prefer Effect.fn for reusable generator functions.",
    },
    messages: {
      preferEffectFn:
        "Use an inline anonymous generator with Effect.gen, or use Effect.fn for a reusable generator function.",
      preferEffectFnDeclaration:
        'Use `const {{name}} = Effect.fn("{{name}}")(function* (...) {...}, ...pipeables)` instead of a function that returns Effect.gen.',
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (!isEffectGen(node)) return;
        const hasAnonymousGenerator = node.arguments.some(
          (argument) =>
            argument.type === "FunctionExpression" && argument.generator && argument.id === null,
        );
        if (hasAnonymousGenerator) return;
        context.report({ node: node.callee, messageId: "preferEffectFn" });
      },
      VariableDeclarator(node) {
        const init = node.init;
        if (node.id.type !== "Identifier" || init?.type !== "ArrowFunctionExpression") return;
        if (init.async || !init.expression || !isGenBody(init.body)) return;
        context.report({
          node: node.id,
          messageId: "preferEffectFnDeclaration",
          data: { name: node.id.name },
        });
      },
    };
  },
});

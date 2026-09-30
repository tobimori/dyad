import { defineRule } from "vite-plus/lint/plugins";

import type { ESTree } from "vite-plus/lint/plugins";

const isEffectGen = (node: ESTree.CallExpression) => {
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

/** Allow inline anonymous generators; prefer Effect.fn for reusable generator functions */
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
    };
  },
});

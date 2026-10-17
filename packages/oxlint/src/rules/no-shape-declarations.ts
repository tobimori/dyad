import { defineRule } from "vite-plus/lint/plugins";

import type { ESTree } from "vite-plus/lint/plugins";

const isInsideModuleDeclaration = (node: ESTree.Node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "TSModuleDeclaration") return true;
  }
  return false;
};

/** Model value shapes with Effect Schema or Data classes instead of interfaces and object type aliases. */
export const noShapeDeclarationsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow interfaces and object type aliases outside module augmentation; use Schema.Class or Data.Class.",
    },
    messages: {
      shape:
        "Do not declare a value shape with `{{kind}}`. Use `Schema.Class` for data that crosses a boundary, `Data.Class` for values that code constructs, or an inline type for a parameter. If nothing else works, suppress this rule with the reason.",
    },
  },
  createOnce(context) {
    return {
      TSInterfaceDeclaration(node) {
        if (isInsideModuleDeclaration(node)) return;
        context.report({ node, messageId: "shape", data: { kind: "interface" } });
      },
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation.type !== "TSTypeLiteral") return;
        context.report({ node, messageId: "shape", data: { kind: "type" } });
      },
    };
  },
});

/**
 * @fileoverview A rule to ensure whitespace before blocks.
 * @author Mathias Schreck <https://github.com/lo1tuma>
 * @copyright 2014 Mathias Schreck. All rights reserved.
 */

"use strict";

var astUtils = require("../ast-utils");

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = function(context) {
    var requireSpace = context.options[0] !== "never";

    /**
     * Checks whether or not a given token is an arrow operator (=>).
     *
     * @param {Token} token - A token to check.
     * @returns {boolean} `true` if the token is an arrow operator.
     */
    function isArrow(token) {
        return token.type === "Punctuator" && token.value === "=>";
    }

    /**
     * Checks the given BlockStatement node has a preceding space if it doesn’t start on a new line.
     * @param {ASTNode|Token} node The AST node of a BlockStatement.
     * @returns {void} undefined.
     */
    function checkPrecedingSpace(node) {
        var precedingToken = context.getTokenBefore(node),
            hasSpace;

        if (precedingToken && !isArrow(precedingToken) && astUtils.isTokenOnSameLine(precedingToken, node)) {
            hasSpace = astUtils.isTokenSpaced(precedingToken, node);

            if (requireSpace) {
                if (!hasSpace) {
                    context.report({
                        node: node,
                        message: "Missing space before opening brace.",
                        fix: function(fixer) {
                            return fixer.insertTextBefore(node, " ");
                        }
                    });
                }
            } else {
                if (hasSpace) {
                    context.report({
                        node: node,
                        message: "Unexpected space before opening brace.",
                        fix: function(fixer) {
                            return fixer.removeRange([precedingToken.range[1], node.range[0]]);
                        }
                    });
                }
            }
        }
    }

    /**
     * Checks if the CaseBlock of an given SwitchStatement node has a preceding space.
     * @param {ASTNode} node The node of a SwitchStatement.
     * @returns {void} undefined.
     */
    function checkSpaceBeforeCaseBlock(node) {
        var cases = node.cases,
            firstCase,
            openingBrace;

        if (cases.length > 0) {
            firstCase = cases[0];
            openingBrace = context.getTokenBefore(firstCase);
        } else {
            openingBrace = context.getLastToken(node, 1);
        }

        checkPrecedingSpace(openingBrace);
    }

    return {
        "BlockStatement": checkPrecedingSpace,
        "ClassBody": checkPrecedingSpace,
        "SwitchStatement": checkSpaceBeforeCaseBlock
    };

};

module.exports.schema = [
    {
        "enum": ["always", "never"]
    }
];

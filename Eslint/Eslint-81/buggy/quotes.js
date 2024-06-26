/**
 * @fileoverview A rule to choose between single and double quote marks
 * @author Matt DuVall <http://www.mattduvall.com/>, Brandon Payton
 */

"use strict";

//------------------------------------------------------------------------------
// Constants
//------------------------------------------------------------------------------

var QUOTE_SETTINGS = {
    "double": {
        quote: "\"",
        alternateQuote: "'",
        description: "doublequote"
    },
    "single": {
        quote: "'",
        alternateQuote: "\"",
        description: "singlequote"
    },
    "backtick": {
        quote: "`",
        alternateQuote: "\"",
        description: "backtick"
    }
};

var AVOID_ESCAPE = "avoid-escape";

var FUNCTION_TYPE = /^(?:Arrow)?Function(?:Declaration|Expression)$/;

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = function(context) {

    /**
     * Validate that a string passed in is surrounded by the specified character
     * @param  {string} val The text to check.
     * @param  {string} character The character to see if it's surrounded by.
     * @returns {boolean} True if the text is surrounded by the character, false if not.
     * @private
     */
    function isSurroundedBy(val, character) {
        return val[0] === character && val[val.length - 1] === character;
    }

    /**
     * Determines if a given node is part of JSX syntax.
     * @param {ASTNode} node The node to check.
     * @returns {boolean} True if the node is a JSX node, false if not.
     * @private
     */
    function isJSXElement(node) {
        return node.type.indexOf("JSX") === 0;
    }

    /**
     * Checks whether or not a given node is a directive.
     * The directive is a `ExpressionStatement` which has only a string literal.
     * @param {ASTNode} node - A node to check.
     * @returns {boolean} Whether or not the node is a directive.
     * @private
     */
    function isDirective(node) {
        return (
            node.type === "ExpressionStatement" &&
            node.expression.type === "Literal" &&
            typeof node.expression.value === "string"
        );
    }

    /**
     * Checks whether or not a given node is a part of directive prologues.
     * See also: http://www.ecma-international.org/ecma-262/6.0/#sec-directive-prologues-and-the-use-strict-directive
     * @param {ASTNode} node - A node to check.
     * @returns {boolean} Whether or not the node is a part of directive prologues.
     * @private
     */
    function isPartOfDirectivePrologue(node) {
        if (!isDirective(node.parent)) {
            return false;
        }

        var block = node.parent.parent;
        if (block.type !== "Program" && (block.type !== "BlockStatement" || !FUNCTION_TYPE.test(block.parent.type))) {
            return false;
        }

        // Check the node is at a prologue.
        for (var i = 0; i < block.body.length; ++i) {
            var statement = block.body[i];

            if (statement === node.parent) {
                return true;
            }
            if (!isDirective(statement)) {
                break;
            }
        }

        return false;
    }

    return {

        "Literal": function(node) {
            var val = node.value,
                rawVal = node.raw,
                quoteOption = context.options[0],
                settings = QUOTE_SETTINGS[quoteOption || "double"],
                avoidEscape = context.options[1] === AVOID_ESCAPE,
                isValid;

            if (settings && typeof val === "string") {
                isValid = (quoteOption === "backtick" && isPartOfDirectivePrologue(node)) || isJSXElement(node.parent) || isSurroundedBy(rawVal, settings.quote);

                if (!isValid && avoidEscape) {
                    isValid = isSurroundedBy(rawVal, settings.alternateQuote) && rawVal.indexOf(settings.quote) >= 0;
                }

                if (!isValid) {
                    context.report(node, "Strings must use " + settings.description + ".");
                }
            }
        }
    };

};

module.exports.schema = [
    {
        "enum": ["single", "double", "backtick"]
    },
    {
        "enum": ["avoid-escape"]
    }
];

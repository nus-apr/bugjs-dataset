/**
 * @fileoverview This option sets a specific tab width for your code
 *
 * @author Teddy Katz
 * @author Vitaly Puzrin
 * @author Gyandeep Singh
 */

"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const lodash = require("lodash");
const astUtils = require("../ast-utils");
const createTree = require("functional-red-black-tree");

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

const KNOWN_NODES = new Set([
    "AssignmentExpression",
    "AssignmentPattern",
    "ArrayExpression",
    "ArrayPattern",
    "ArrowFunctionExpression",
    "AwaitExpression",
    "BlockStatement",
    "BinaryExpression",
    "BreakStatement",
    "CallExpression",
    "CatchClause",
    "ClassBody",
    "ClassDeclaration",
    "ClassExpression",
    "ConditionalExpression",
    "ContinueStatement",
    "DoWhileStatement",
    "DebuggerStatement",
    "EmptyStatement",
    "ExperimentalRestProperty",
    "ExperimentalSpreadProperty",
    "ExpressionStatement",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "FunctionDeclaration",
    "FunctionExpression",
    "Identifier",
    "IfStatement",
    "Literal",
    "LabeledStatement",
    "LogicalExpression",
    "MemberExpression",
    "MetaProperty",
    "MethodDefinition",
    "NewExpression",
    "ObjectExpression",
    "ObjectPattern",
    "Program",
    "Property",
    "RestElement",
    "ReturnStatement",
    "SequenceExpression",
    "SpreadElement",
    "Super",
    "SwitchCase",
    "SwitchStatement",
    "TaggedTemplateExpression",
    "TemplateElement",
    "TemplateLiteral",
    "ThisExpression",
    "ThrowStatement",
    "TryStatement",
    "UnaryExpression",
    "UpdateExpression",
    "VariableDeclaration",
    "VariableDeclarator",
    "WhileStatement",
    "WithStatement",
    "YieldExpression",
    "JSXIdentifier",
    "JSXNamespacedName",
    "JSXMemberExpression",
    "JSXEmptyExpression",
    "JSXExpressionContainer",
    "JSXElement",
    "JSXClosingElement",
    "JSXOpeningElement",
    "JSXAttribute",
    "JSXSpreadAttribute",
    "JSXText",
    "ExportDefaultDeclaration",
    "ExportNamedDeclaration",
    "ExportAllDeclaration",
    "ExportSpecifier",
    "ImportDeclaration",
    "ImportSpecifier",
    "ImportDefaultSpecifier",
    "ImportNamespaceSpecifier"
]);

/*
 * General rule strategy:
 * 1. An OffsetStorage instance stores a map of desired offsets, where each token has a specified offset from another
 *    specified token or to the first column.
 * 2. As the AST is traversed, modify the desired offsets of tokens accordingly. For example, when entering a
 *    BlockStatement, offset all of the tokens in the BlockStatement by 1 indent level from the opening curly
 *    brace of the BlockStatement.
 * 3. After traversing the AST, calculate the expected indentation levels of every token according to the
 *    OffsetStorage container.
 * 4. For each line, compare the expected indentation of the first token to the actual indentation in the file,
 *    and report the token if the two values are not equal.
 */


/**
 * A mutable balanced binary search tree that stores (key, value) pairs. The keys are numeric, and must be unique.
 * This is intended to be a generic wrapper around a balanced binary search tree library, so that the underlying implementation
 * can easily be swapped out.
 */
class BinarySearchTree {

    /**
     * Creates an empty tree
     */
    constructor() {
        this._rbTree = createTree();
    }

    /**
     * Inserts an entry into the tree.
     * @param {number} key The entry's key
     * @param {*} value The entry's value
     * @returns {void}
     */
    insert(key, value) {
        const iterator = this._rbTree.find(key);

        if (iterator.valid) {
            this._rbTree = iterator.update(value);
        } else {
            this._rbTree = this._rbTree.insert(key, value);
        }
    }

    /**
     * Finds the entry with the largest key less than or equal to the provided key
     * @param {number} key The provided key
     * @returns {{key: number, value: *}|null} The found entry, or null if no such entry exists.
     */
    findLe(key) {
        const iterator = this._rbTree.le(key);

        return iterator && { key: iterator.key, value: iterator.value };
    }

    /**
     * Deletes all of the keys in the interval [start, end)
     * @param {number} start The start of the range
     * @param {number} end The end of the range
     * @returns {void}
     */
    deleteRange(start, end) {

        // Exit without traversing the tree if the range has zero size.
        if (start === end) {
            return;
        }
        const iterator = this._rbTree.ge(start);

        while (iterator.valid && iterator.key < end) {
            this._rbTree = this._rbTree.remove(iterator.key);
            iterator.next();
        }
    }
}

/**
 * A helper class to get token-based info related to indentation
 */
class TokenInfo {

    /**
     * @param {SourceCode} sourceCode A SourceCode object
     */
    constructor(sourceCode) {
        this.sourceCode = sourceCode;
        this.firstTokensByLineNumber = sourceCode.tokensAndComments.reduce((map, token) => {
            if (!map.has(token.loc.start.line)) {
                map.set(token.loc.start.line, token);
            }
            if (!map.has(token.loc.end.line) && sourceCode.text.slice(token.range[1] - token.loc.end.column, token.range[1]).trim()) {
                map.set(token.loc.end.line, token);
            }
            return map;
        }, new Map());
    }

    /**
    * Gets the first token on a given token's line
    * @param {Token|ASTNode} token a node or token
    * @returns {Token} The first token on the given line
    */
    getFirstTokenOfLine(token) {
        return this.firstTokensByLineNumber.get(token.loc.start.line);
    }

    /**
    * Determines whether a token is the first token in its line
    * @param {Token} token The token
    * @returns {boolean} `true` if the token is the first on its line
    */
    isFirstTokenOfLine(token) {
        return this.getFirstTokenOfLine(token) === token;
    }

    /**
     * Get the actual indent of a token
     * @param {Token} token Token to examine. This should be the first token on its line.
     * @returns {string} The indentation characters that precede the token
     */
    getTokenIndent(token) {
        return this.sourceCode.text.slice(token.range[0] - token.loc.start.column, token.range[0]);
    }
}

/**
 * A class to store information on desired offsets of tokens from each other
 */
class OffsetStorage {

    /**
     * @param {TokenInfo} tokenInfo a TokenInfo instance
     * @param {number} indentSize The desired size of each indentation level
     */
    constructor(tokenInfo, indentSize) {
        this._tokenInfo = tokenInfo;
        this._indentSize = indentSize;

        this._tree = new BinarySearchTree();
        this._tree.insert(0, { offset: 0, from: null, force: false });

        this._lockedFirstTokens = new WeakMap();
        this._desiredIndentCache = new WeakMap();
        this._ignoredTokens = new WeakSet();
    }

    _getOffsetDescriptor(token) {
        return this._tree.findLe(token.range[0]).value;
    }

    /**
    * Sets the indent of one token to match the indent of another.
    * @param {Token} baseToken The first token
    * @param {Token} offsetToken The second token, whose indent should be matched to the first token
    * @returns {void}
    */
    matchIndentOf(baseToken, offsetToken) {
        return this.setDesiredOffsets(offsetToken.range, baseToken, 0);
    }

    /**
     * Sets the offset column of token B to match the offset column of token A.
     * **WARNING**: This is different from matchIndentOf because it matches a *column*, even if baseToken is not
     * the first token on its line. In most cases, `matchIndentOf` should be used instead.
     * @param {Token} baseToken The first token
     * @param {Token} offsetToken The second token, whose offset should be matched to the first token
     * @returns {void}
     */
    matchOffsetOf(baseToken, offsetToken) {

        /*
         * lockedFirstTokens is a map from a token whose indentation is controlled by the "first" option to
         * the token that it depends on. For example, with the `ArrayExpression: first` option, the first
         * token of each element in the array after the first will be mapped to the first token of the first
         * element. The desired indentation of each of these tokens is computed based on the desired indentation
         * of the "first" element, rather than through the normal offset mechanism.
         */
        this._lockedFirstTokens.set(offsetToken, baseToken);
    }

    /**
     * Sets the desired offset of a token.
     *
     * This uses a line-based offset collapsing behavior to handle tokens on the same line.
     * For example, consider the following two cases:
     *
     * (
     *     [
     *         bar
     *     ]
     * )
     *
     * ([
     *     bar
     * ])
     *
     * Based on the first case, it's clear that the `bar` token needs to have an offset of 1 indent level (4 spaces) from
     * the `[` token, and the `[` token has to have an offset of 1 indent level from the `(` token. Since the `(` token is
     * the first on its line (with an indent of 0 spaces), the `bar` token needs to be offset by 2 indent levels (8 spaces)
     * from the start of its line.
     *
     * However, in the second case `bar` should only be indented by 4 spaces. This is because the offset of 1 indent level
     * between the `(` and the `[` tokens gets "collapsed" because the two tokens are on the same line. As a result, the
     * `(` token is mapped to the `[` token with an offset of 0, and the rule correctly decides that `bar` should be indented
     * by 1 indent level from the start of the line.
     *
     * This is useful because rule listeners can usually just call `setDesiredOffset` for all the tokens in the node,
     * without needing to check which lines those tokens are on.
     *
     * Note that since collapsing only occurs when two tokens are on the same line, there are a few cases where non-intuitive
     * behavior can occur. For example, consider the following cases:
     *
     * foo(
     * ).
     *     bar(
     *         baz
     *     )
     *
     * foo(
     * ).bar(
     *     baz
     * )
     *
     * Based on the first example, it would seem that `bar` should be offset by 1 indent level from `foo`, and `baz`
     * should be offset by 1 indent level from `bar`. However, this is not correct, because it would result in `baz`
     * being indented by 2 indent levels in the second case (since `foo`, `bar`, and `baz` are all on separate lines, no
     * collapsing would occur).
     *
     * Instead, the correct way would be to offset `baz` by 1 level from `bar`, offset `bar` by 1 level from the `)`, and
     * offset the `)` by 0 levels from `foo`. This ensures that the offset between `bar` and the `)` are correctly collapsed
     * in the second case.
     *
     * @param {Token} token The token
     * @param {Token} fromToken The token that `token` should be offset from
     * @param {number} offset The desired indent level
     * @returns {void}
     */
    setDesiredOffset(token, fromToken, offset) {
        return this.setDesiredOffsets(token.range, fromToken, offset);
    }

    /**
    * Sets the desired offset of all tokens in a range
    * It's common for node listeners in this file to need to apply the same offset to a large, contiguous range of tokens.
    * Moreover, the offset of any given token is usually updated multiple times (roughly once for each node that contains
    * it). This means that the offset of each token is updated O(AST depth) times.
    * It would not be performant to store and update the offsets for each token independently, because the rule would end
    * up having a time complexity of O(number of tokens * AST depth), which is quite slow for large files.
    *
    * Instead, the offset tree is represented as a collection of contiguous offset ranges in a file. For example, the following
    * list could represent the state of the offset tree at a given point:
    *
    * * Tokens starting in the interval [0, 15) are aligned with the beginning of the file
    * * Tokens starting in the interval [15, 30) are offset by 1 indent level from the `bar` token
    * * Tokens starting in the interval [30, 43) are offset by 1 indent level from the `foo` token
    * * Tokens starting in the interval [43, 820) are offset by 2 indent levels from the `bar` token
    * * Tokens starting in the interval [820, ∞) are offset by 1 indent level from the `baz` token
    *
    * The `setDesiredOffsets` methods inserts ranges like the ones above. The third line above would be inserted by using:
    * `setDesiredOffsets([30, 43], fooToken, 1);`
    *
    * @param {[number, number]} range A [start, end] pair. All tokens with range[0] <= token.start < range[1] will have the offset applied.
    * @param {Token} fromToken The token that this is offset from
    * @param {number} offset The desired indent level
    * @param {boolean} force `true` if this offset should not use the normal collapsing behavior. This should almost always be false.
    * @returns {void}
    */
    setDesiredOffsets(range, fromToken, offset, force) {

        /*
         * Offset ranges are stored as a collection of nodes, where each node maps a numeric key to an offset
         * descriptor. The tree for the example above would have the following nodes:
         *
         * * key: 0, value: { offset: 0, from: null }
         * * key: 30, value: { offset: 1, from: fooToken }
         * * key: 43, value: { offset: 2, from: barToken }
         * * key: 820, value: { offset: 1, from: bazToken }
         *
         * To find the offset descriptor for any given token, one needs to find the node with the largest key
         * which is <= token.start. To make this operation fast, the nodes are stored in a balanced binary
         * search tree indexed by key.
         */

        const descriptorToInsert = { offset, from: fromToken, force };

        const descriptorAfterRange = this._tree.findLe(range[1]).value;

        const fromTokenIsInRange = fromToken && fromToken.range[0] >= range[0] && fromToken.range[1] <= range[1];
        const fromTokenDescriptor = fromTokenIsInRange && this._getOffsetDescriptor(fromToken);

        // First, remove any existing nodes in the range from the tree.
        this._tree.deleteRange(range[0] + 1, range[1]);

        // Insert a new node into the tree for this range
        this._tree.insert(range[0], descriptorToInsert);

        /*
         * To avoid circular offset dependencies, keep the `fromToken` token mapped to whatever it was mapped to previously,
         * even if it's in the current range.
         */
        if (fromTokenIsInRange) {
            this._tree.insert(fromToken.range[0], fromTokenDescriptor);
            this._tree.insert(fromToken.range[1], descriptorToInsert);
        }

        /*
         * To avoid modifying the offset of tokens after the range, insert another node to keep the offset of the following
         * tokens the same as it was before.
         */
        this._tree.insert(range[1], descriptorAfterRange);
    }

    /**
    * Gets the desired indent of a token
    * @param {Token} token The token
    * @returns {number} The desired indent of the token
    */
    getDesiredIndent(token) {
        if (!this._desiredIndentCache.has(token)) {

            if (this._ignoredTokens.has(token)) {

                // If the token is ignored, use the actual indent of the token as the desired indent.
                // This ensures that no errors are reported for this token.
                this._desiredIndentCache.set(token, this._tokenInfo.getTokenIndent(token).length / this._indentSize);
            } else if (this._lockedFirstTokens.has(token)) {
                const firstToken = this._lockedFirstTokens.get(token);

                this._desiredIndentCache.set(
                    token,

                    // (indentation for the first element's line)
                    this.getDesiredIndent(this._tokenInfo.getFirstTokenOfLine(firstToken)) +

                        // (space between the start of the first element's line and the first element)
                        (firstToken.loc.start.column - this._tokenInfo.getFirstTokenOfLine(firstToken).loc.start.column) / this._indentSize
                );
            } else {
                const offsetInfo = this._getOffsetDescriptor(token);
                const offset = (
                    offsetInfo.from &&
                    offsetInfo.from.loc.start.line === token.loc.start.line &&
                    !offsetInfo.force
                ) ? 0 : offsetInfo.offset;

                this._desiredIndentCache.set(token, offset + (offsetInfo.from ? this.getDesiredIndent(offsetInfo.from) : 0));
            }
        }
        return this._desiredIndentCache.get(token);
    }

    /**
    * Ignores a token, preventing it from being reported.
    * @param {Token} token The token
    * @returns {void}
    */
    ignoreToken(token) {
        if (this._tokenInfo.isFirstTokenOfLine(token)) {
            this._ignoredTokens.add(token);
        }
    }

    /**
     * Gets the first token that the given token's indentation is dependent on
     * @param {Token} token The token
     * @returns {Token} The token that the given token depends on, or `null` if the given token is at the top level
     */
    getFirstDependency(token) {
        return this._getOffsetDescriptor(token).from;
    }
}

const ELEMENT_LIST_SCHEMA = {
    oneOf: [
        {
            type: "integer",
            minimum: 0
        },
        {
            enum: ["first", "off"]
        }
    ]
};

module.exports = {
    meta: {
        docs: {
            description: "enforce consistent indentation",
            category: "Stylistic Issues",
            recommended: false
        },

        fixable: "whitespace",

        schema: [
            {
                oneOf: [
                    {
                        enum: ["tab"]
                    },
                    {
                        type: "integer",
                        minimum: 0
                    }
                ]
            },
            {
                type: "object",
                properties: {
                    SwitchCase: {
                        type: "integer",
                        minimum: 0
                    },
                    VariableDeclarator: {
                        oneOf: [
                            {
                                type: "integer",
                                minimum: 0
                            },
                            {
                                type: "object",
                                properties: {
                                    var: {
                                        type: "integer",
                                        minimum: 0
                                    },
                                    let: {
                                        type: "integer",
                                        minimum: 0
                                    },
                                    const: {
                                        type: "integer",
                                        minimum: 0
                                    }
                                },
                                additionalProperties: false
                            }
                        ]
                    },
                    outerIIFEBody: {
                        type: "integer",
                        minimum: 0
                    },
                    MemberExpression: {
                        oneOf: [
                            {
                                type: "integer",
                                minimum: 0
                            },
                            {
                                enum: ["off"]
                            }
                        ]
                    },
                    FunctionDeclaration: {
                        type: "object",
                        properties: {
                            parameters: ELEMENT_LIST_SCHEMA,
                            body: {
                                type: "integer",
                                minimum: 0
                            }
                        },
                        additionalProperties: false
                    },
                    FunctionExpression: {
                        type: "object",
                        properties: {
                            parameters: ELEMENT_LIST_SCHEMA,
                            body: {
                                type: "integer",
                                minimum: 0
                            }
                        },
                        additionalProperties: false
                    },
                    CallExpression: {
                        type: "object",
                        properties: {
                            arguments: ELEMENT_LIST_SCHEMA
                        },
                        additionalProperties: false
                    },
                    ArrayExpression: ELEMENT_LIST_SCHEMA,
                    ObjectExpression: ELEMENT_LIST_SCHEMA,
                    flatTernaryExpressions: {
                        type: "boolean"
                    }
                },
                additionalProperties: false
            }
        ]
    },

    create(context) {
        const DEFAULT_VARIABLE_INDENT = 1;
        const DEFAULT_PARAMETER_INDENT = 1;
        const DEFAULT_FUNCTION_BODY_INDENT = 1;

        let indentType = "space";
        let indentSize = 4;
        const options = {
            SwitchCase: 0,
            VariableDeclarator: {
                var: DEFAULT_VARIABLE_INDENT,
                let: DEFAULT_VARIABLE_INDENT,
                const: DEFAULT_VARIABLE_INDENT
            },
            outerIIFEBody: 1,
            FunctionDeclaration: {
                parameters: DEFAULT_PARAMETER_INDENT,
                body: DEFAULT_FUNCTION_BODY_INDENT
            },
            FunctionExpression: {
                parameters: DEFAULT_PARAMETER_INDENT,
                body: DEFAULT_FUNCTION_BODY_INDENT
            },
            CallExpression: {
                arguments: DEFAULT_PARAMETER_INDENT
            },
            MemberExpression: 1,
            ArrayExpression: 1,
            ObjectExpression: 1,
            ArrayPattern: 1,
            ObjectPattern: 1,
            flatTernaryExpressions: false
        };

        if (context.options.length) {
            if (context.options[0] === "tab") {
                indentSize = 1;
                indentType = "tab";
            } else if (typeof context.options[0] === "number") {
                indentSize = context.options[0];
                indentType = "space";
            }

            if (context.options[1]) {
                lodash.merge(options, context.options[1]);

                if (typeof options.VariableDeclarator === "number") {
                    options.VariableDeclarator = {
                        var: options.VariableDeclarator,
                        let: options.VariableDeclarator,
                        const: options.VariableDeclarator
                    };
                }
            }
        }

        const sourceCode = context.getSourceCode();
        const tokenInfo = new TokenInfo(sourceCode);
        const offsets = new OffsetStorage(tokenInfo, indentSize);
        const parameterParens = new WeakSet();

        /**
         * Creates an error message for a line, given the expected/actual indentation.
         * @param {int} expectedAmount The expected amount of indentation characters for this line
         * @param {int} actualSpaces The actual number of indentation spaces that were found on this line
         * @param {int} actualTabs The actual number of indentation tabs that were found on this line
         * @returns {string} An error message for this line
         */
        function createErrorMessage(expectedAmount, actualSpaces, actualTabs) {
            const expectedStatement = `${expectedAmount} ${indentType}${expectedAmount === 1 ? "" : "s"}`; // e.g. "2 tabs"
            const foundSpacesWord = `space${actualSpaces === 1 ? "" : "s"}`; // e.g. "space"
            const foundTabsWord = `tab${actualTabs === 1 ? "" : "s"}`; // e.g. "tabs"
            let foundStatement;

            if (actualSpaces > 0) {

                // Abbreviate the message if the expected indentation is also spaces.
                // e.g. 'Expected 4 spaces but found 2' rather than 'Expected 4 spaces but found 2 spaces'
                foundStatement = indentType === "space" ? actualSpaces : `${actualSpaces} ${foundSpacesWord}`;
            } else if (actualTabs > 0) {
                foundStatement = indentType === "tab" ? actualTabs : `${actualTabs} ${foundTabsWord}`;
            } else {
                foundStatement = "0";
            }

            return `Expected indentation of ${expectedStatement} but found ${foundStatement}.`;
        }

        /**
         * Reports a given indent violation
         * @param {Token} token Node violating the indent rule
         * @param {int} neededIndentLevel Expected indentation level
         * @param {int} gottenSpaces Indentation space count in the actual node/code
         * @param {int} gottenTabs Indentation tab count in the actual node/code
         * @returns {void}
         */
        function report(token, neededIndentLevel) {
            const actualIndent = Array.from(tokenInfo.getTokenIndent(token));
            const numSpaces = actualIndent.filter(char => char === " ").length;
            const numTabs = actualIndent.filter(char => char === "\t").length;
            const neededChars = neededIndentLevel * indentSize;

            context.report({
                node: token,
                message: createErrorMessage(neededChars, numSpaces, numTabs),
                loc: {
                    start: { line: token.loc.start.line, column: 0 },
                    end: { line: token.loc.start.line, column: token.loc.start.column }
                },
                fix(fixer) {
                    const range = [token.range[0] - token.loc.start.column, token.range[0]];
                    const newText = (indentType === "space" ? " " : "\t").repeat(neededChars);

                    return fixer.replaceTextRange(range, newText);
                }
            });
        }

        /**
         * Checks if a token's indentation is correct
         * @param {Token} token Token to examine
         * @param {int} desiredIndentLevel needed indent level
         * @returns {boolean} `true` if the token's indentation is correct
         */
        function validateTokenIndent(token, desiredIndentLevel) {
            const indentation = tokenInfo.getTokenIndent(token);
            const expectedChar = indentType === "space" ? " " : "\t";

            return indentation === expectedChar.repeat(desiredIndentLevel * indentSize) ||

                // To avoid conflicts with no-mixed-spaces-and-tabs, don't report mixed spaces and tabs.
                indentation.includes(" ") && indentation.includes("\t");
        }

        /**
         * Check to see if the node is a file level IIFE
         * @param {ASTNode} node The function node to check.
         * @returns {boolean} True if the node is the outer IIFE
         */
        function isOuterIIFE(node) {

            /*
             * Verify that the node is an IIFE
             */
            if (!node.parent || node.parent.type !== "CallExpression" || node.parent.callee !== node) {
                return false;
            }

            /*
             * Navigate legal ancestors to determine whether this IIFE is outer.
             * A "legal ancestor" is an expression or statement that causes the function to get executed immediately.
             * For example, `!(function(){})()` is an outer IIFE even though it is preceded by a ! operator.
             */
            let statement = node.parent && node.parent.parent;

            while (
                statement.type === "UnaryExpression" && ["!", "~", "+", "-"].indexOf(statement.operator) > -1 ||
                statement.type === "AssignmentExpression" ||
                statement.type === "LogicalExpression" ||
                statement.type === "SequenceExpression" ||
                statement.type === "VariableDeclarator"
            ) {
                statement = statement.parent;
            }

            return (statement.type === "ExpressionStatement" || statement.type === "VariableDeclaration") && statement.parent.type === "Program";
        }

        /**
        * Check indentation for lists of elements (arrays, objects, function params)
        * @param {ASTNode[]} elements List of elements that should be offset
        * @param {Token} startToken The start token of the list that element should be aligned against, e.g. '['
        * @param {Token} endToken The end token of the list, e.g. ']'
        * @param {number|string} offset The amount that the elements should be offset
        * @returns {void}
        */
        function addElementListIndent(elements, startToken, endToken, offset) {

            /**
            * Gets the first token of a given element, including surrounding parentheses.
            * @param {ASTNode} element A node in the `elements` list
            * @returns {Token} The first token of this element
            */
            function getFirstToken(element) {
                let token = sourceCode.getTokenBefore(element);

                while (astUtils.isOpeningParenToken(token) && token !== startToken) {
                    token = sourceCode.getTokenBefore(token);
                }
                return sourceCode.getTokenAfter(token);
            }

            // Run through all the tokens in the list, and offset them by one indent level (mainly for comments, other things will end up overridden)
            offsets.setDesiredOffsets(
                [startToken.range[1], endToken.range[0]],
                startToken,
                offset === "first" ? 1 : offset
            );
            offsets.matchIndentOf(startToken, endToken);

            // If the preference is "first" but there is no first element (e.g. sparse arrays w/ empty first slot), fall back to 1 level.
            if (offset === "first" && elements.length && !elements[0]) {
                return;
            }
            elements.forEach((element, index) => {
                if (offset === "off") {
                    offsets.ignoreToken(getFirstToken(element));
                }
                if (index === 0 || !element) {
                    return;
                }
                if (offset === "first" && tokenInfo.isFirstTokenOfLine(getFirstToken(element))) {
                    offsets.matchOffsetOf(getFirstToken(elements[0]), getFirstToken(element));
                } else {
                    const previousElement = elements[index - 1];
                    const firstTokenOfPreviousElement = previousElement && getFirstToken(previousElement);

                    if (previousElement && sourceCode.getLastToken(previousElement).loc.start.line > startToken.loc.end.line) {
                        offsets.setDesiredOffsets(element.range, firstTokenOfPreviousElement, 0);
                    }
                }
            });
        }

        /**
         * Check indentation for blocks and class bodies
         * @param {ASTNode} node The BlockStatement or ClassBody node to indent
         * @returns {void}
         */
        function addBlockIndent(node) {

            let blockIndentLevel;

            if (node.parent && isOuterIIFE(node.parent)) {
                blockIndentLevel = options.outerIIFEBody;
            } else if (node.parent && (node.parent.type === "FunctionExpression" || node.parent.type === "ArrowFunctionExpression")) {
                blockIndentLevel = options.FunctionExpression.body;
            } else if (node.parent && node.parent.type === "FunctionDeclaration") {
                blockIndentLevel = options.FunctionDeclaration.body;
            } else {
                blockIndentLevel = 1;
            }

            /*
             * For blocks that aren't lone statements, ensure that the opening curly brace
             * is aligned with the parent.
             */
            if (!astUtils.STATEMENT_LIST_PARENTS.has(node.parent.type)) {
                offsets.matchIndentOf(sourceCode.getFirstToken(node.parent), sourceCode.getFirstToken(node));
            }
            addElementListIndent(node.body, sourceCode.getFirstToken(node), sourceCode.getLastToken(node), blockIndentLevel);
        }

        /**
         * Check indent for array block content or object block content
         * @param {ASTNode} node node to examine
         * @returns {void}
         */
        function addArrayOrObjectIndent(node) {
            addElementListIndent(node.elements || node.properties, sourceCode.getFirstToken(node), sourceCode.getLastToken(node), options[node.type]);
        }

        /**
         * Check and decide whether to check for indentation for blockless nodes
         * Scenarios are for or while statements without braces around them
         * @param {ASTNode} node node to examine
         * @returns {void}
         */
        function addBlocklessNodeIndent(node) {
            if (node.type !== "BlockStatement") {
                const lastParentToken = sourceCode.getTokenBefore(node, astUtils.isNotOpeningParenToken);

                let firstBodyToken = sourceCode.getFirstToken(node);
                let lastBodyToken = sourceCode.getLastToken(node);

                while (
                    astUtils.isOpeningParenToken(sourceCode.getTokenBefore(firstBodyToken)) &&
                    astUtils.isClosingParenToken(sourceCode.getTokenAfter(lastBodyToken))
                ) {
                    firstBodyToken = sourceCode.getTokenBefore(firstBodyToken);
                    lastBodyToken = sourceCode.getTokenAfter(lastBodyToken);
                }

                offsets.setDesiredOffsets([firstBodyToken.range[0], lastBodyToken.range[1]], lastParentToken, 1);

                /*
                 * For blockless nodes with semicolon-first style, don't indent the semicolon.
                 * e.g.
                 * if (foo) bar()
                 * ; [1, 2, 3].map(foo)
                 */
                const lastToken = sourceCode.getLastToken(node);

                if (node.type !== "EmptyStatement" && astUtils.isSemicolonToken(lastToken)) {
                    offsets.matchIndentOf(lastParentToken, lastToken);
                }
            }
        }

        /**
        * Checks the indentation for nodes that are like function calls (`CallExpression` and `NewExpression`)
        * @param {ASTNode} node A CallExpression or NewExpression node
        * @returns {void}
        */
        function addFunctionCallIndent(node) {
            let openingParen;

            if (node.arguments.length) {
                openingParen = sourceCode.getFirstTokenBetween(node.callee, node.arguments[0], astUtils.isOpeningParenToken);
            } else {
                openingParen = sourceCode.getLastToken(node, 1);
            }
            const closingParen = sourceCode.getLastToken(node);

            parameterParens.add(openingParen);
            parameterParens.add(closingParen);
            offsets.matchIndentOf(sourceCode.getTokenBefore(openingParen), openingParen);

            addElementListIndent(node.arguments, openingParen, closingParen, options.CallExpression.arguments);
        }

        /**
        * Checks the indentation of ClassDeclarations and ClassExpressions
        * @param {ASTNode} node A ClassDeclaration or ClassExpression node
        * @returns {void}
        */
        function addClassIndent(node) {
            if (node.superClass) {
                const classToken = sourceCode.getFirstToken(node);
                const extendsToken = sourceCode.getTokenBefore(node.superClass, astUtils.isNotOpeningParenToken);

                offsets.setDesiredOffsets([extendsToken.range[0], node.body.range[0]], classToken, 1);
            }
        }

        /**
        * Checks the indentation of parenthesized values, given a list of tokens in a program
        * @param {Token[]} tokens A list of tokens
        * @returns {void}
        */
        function addParensIndent(tokens) {
            const parenStack = [];
            const parenPairs = [];

            tokens.forEach(nextToken => {

                // Accumulate a list of parenthesis pairs
                if (astUtils.isOpeningParenToken(nextToken)) {
                    parenStack.push(nextToken);
                } else if (astUtils.isClosingParenToken(nextToken)) {
                    parenPairs.unshift({ left: parenStack.pop(), right: nextToken });
                }
            });

            parenPairs.forEach(pair => {
                const leftParen = pair.left;
                const rightParen = pair.right;

                // We only want to handle parens around expressions, so exclude parentheses that are in function parameters and function call arguments.
                if (!parameterParens.has(leftParen) && !parameterParens.has(rightParen)) {
                    const parenthesizedTokens = new Set(sourceCode.getTokensBetween(leftParen, rightParen));

                    parenthesizedTokens.forEach(token => {
                        if (!parenthesizedTokens.has(offsets.getFirstDependency(token))) {
                            offsets.setDesiredOffset(token, leftParen, 1);
                        }
                    });
                }

                offsets.matchIndentOf(leftParen, rightParen);
            });
        }

        /**
        * Ignore all tokens within an unknown node whose offset do not depend
        * on another token's offset within the unknown node
        * @param {ASTNode} node Unknown Node
        * @returns {void}
        */
        function ignoreUnknownNode(node) {
            const unknownNodeTokens = new Set(sourceCode.getTokens(node, { includeComments: true }));

            unknownNodeTokens.forEach(token => {
                if (!unknownNodeTokens.has(offsets.getFirstDependency(token))) {
                    const firstTokenOfLine = tokenInfo.getFirstTokenOfLine(token);

                    if (token === firstTokenOfLine) {
                        offsets.ignoreToken(token);
                    } else {
                        offsets.matchIndentOf(firstTokenOfLine, token);
                    }
                }
            });
        }

        /**
        * Ignore node if it is unknown
        * @param {ASTNode} node Node
        * @returns {void}
        */
        function checkForUnknownNode(node) {
            const isNodeUnknown = !(KNOWN_NODES.has(node.type));

            if (isNodeUnknown) {
                ignoreUnknownNode(node);
            }
        }

        /**
         * Check whether the given token is the first token of a statement.
         * @param {Token} token The token to check.
         * @param {ASTNode} leafNode The expression node that the token belongs directly.
         * @returns {boolean} `true` if the token is the first token of a statement.
         */
        function isFirstTokenOfStatement(token, leafNode) {
            let node = leafNode;

            while (node.parent && !node.parent.type.endsWith("Statement") && !node.parent.type.endsWith("Declaration")) {
                node = node.parent;
            }
            node = node.parent;

            return !node || node.range[0] === token.range[0];
        }

        return {
            ArrayExpression: addArrayOrObjectIndent,
            ArrayPattern: addArrayOrObjectIndent,

            ArrowFunctionExpression(node) {
                const firstToken = sourceCode.getFirstToken(node);

                if (astUtils.isOpeningParenToken(firstToken)) {
                    const openingParen = firstToken;
                    const closingParen = sourceCode.getTokenBefore(node.body, astUtils.isClosingParenToken);

                    parameterParens.add(openingParen);
                    parameterParens.add(closingParen);
                    addElementListIndent(node.params, openingParen, closingParen, options.FunctionExpression.parameters);
                }
                addBlocklessNodeIndent(node.body);

                let arrowToken;

                if (node.params.length) {
                    arrowToken = sourceCode.getTokenAfter(node.params[node.params.length - 1], astUtils.isArrowToken);
                } else {
                    arrowToken = sourceCode.getFirstToken(node, astUtils.isArrowToken);
                }
                offsets.matchIndentOf(sourceCode.getFirstToken(node), arrowToken);
            },

            AssignmentExpression(node) {
                const operator = sourceCode.getFirstTokenBetween(node.left, node.right, token => token.value === node.operator);

                offsets.setDesiredOffsets([operator.range[0], node.range[1]], sourceCode.getLastToken(node.left), 1);
                offsets.ignoreToken(operator);
                offsets.ignoreToken(sourceCode.getTokenAfter(operator));
            },

            "BinaryExpression, LogicalExpression"(node) {
                const operator = sourceCode.getFirstTokenBetween(node.left, node.right, token => token.value === node.operator);

                /*
                * For backwards compatibility, don't check BinaryExpression indents, e.g.
                * var foo = bar &&
                *                   baz;
                */

                const tokenAfterOperator = sourceCode.getTokenAfter(operator);

                offsets.ignoreToken(operator);
                offsets.ignoreToken(tokenAfterOperator);
                offsets.setDesiredOffset(tokenAfterOperator, operator, 0);
                offsets.setDesiredOffsets([tokenAfterOperator.range[1], node.range[1]], tokenAfterOperator, 1);
            },

            BlockStatement: addBlockIndent,

            CallExpression: addFunctionCallIndent,

            ClassBody: addBlockIndent,

            ClassDeclaration: addClassIndent,

            ClassExpression: addClassIndent,

            ConditionalExpression(node) {
                const firstToken = sourceCode.getFirstToken(node);

                // `flatTernaryExpressions` option is for the following style:
                // var a =
                //     foo > 0 ? bar :
                //     foo < 0 ? baz :
                //     /*else*/ qiz ;
                if (!options.flatTernaryExpressions ||
                    !astUtils.isTokenOnSameLine(node.test, node.consequent) ||
                    isFirstTokenOfStatement(firstToken, node)
                ) {
                    const questionMarkToken = sourceCode.getFirstTokenBetween(node.test, node.consequent, token => token.type === "Punctuator" && token.value === "?");
                    const colonToken = sourceCode.getFirstTokenBetween(node.consequent, node.alternate, token => token.type === "Punctuator" && token.value === ":");

                    const firstConsequentToken = sourceCode.getTokenAfter(questionMarkToken, { includeComments: true });
                    const lastConsequentToken = sourceCode.getTokenBefore(colonToken, { includeComments: true });
                    const firstAlternateToken = sourceCode.getTokenAfter(colonToken);

                    offsets.setDesiredOffset(questionMarkToken, firstToken, 1);
                    offsets.setDesiredOffset(colonToken, firstToken, 1);

                    offsets.setDesiredOffset(firstConsequentToken, firstToken, 1);

                    /*
                     * The alternate and the consequent should usually have the same indentation.
                     * If they share part of a line, align the alternate against the first token of the consequent.
                     * This allows the alternate to be indented correctly in cases like this:
                     * foo ? (
                     *   bar
                     * ) : ( // this '(' is aligned with the '(' above, so it's considered to be aligned with `foo`
                     *   baz // as a result, `baz` is offset by 1 rather than 2
                     * )
                     */
                    if (lastConsequentToken.loc.end.line === firstAlternateToken.loc.start.line) {
                        offsets.matchIndentOf(firstConsequentToken, firstAlternateToken);
                    } else {

                        /**
                         * If the alternate and consequent do not share part of a line, offset the alternate from the first
                         * token of the conditional expression. For example:
                         * foo ? bar
                         *   : baz
                         *
                         * If `baz` were aligned with `bar` rather than being offset by 1 from `foo`, `baz` would end up
                         * having no expected indentation.
                         */
                        offsets.setDesiredOffset(firstAlternateToken, firstToken, 1);
                    }

                    offsets.setDesiredOffsets([questionMarkToken.range[1], colonToken.range[0]], firstConsequentToken, 0);
                    offsets.setDesiredOffsets([colonToken.range[1], node.range[1]], firstAlternateToken, 0);
                }
            },

            DoWhileStatement: node => addBlocklessNodeIndent(node.body),

            ExportNamedDeclaration(node) {
                if (node.declaration === null) {
                    const closingCurly = sourceCode.getLastToken(node, astUtils.isClosingBraceToken);

                    // Indent the specifiers in `export {foo, bar, baz}`
                    addElementListIndent(node.specifiers, sourceCode.getFirstToken(node, { skip: 1 }), closingCurly, 1);

                    if (node.source) {

                        // Indent everything after and including the `from` token in `export {foo, bar, baz} from 'qux'`
                        offsets.setDesiredOffsets([closingCurly.range[1], node.range[1]], sourceCode.getFirstToken(node), 1);
                    }
                }
            },

            ForInStatement: node => addBlocklessNodeIndent(node.body),

            ForOfStatement: node => addBlocklessNodeIndent(node.body),

            ForStatement(node) {
                const forOpeningParen = sourceCode.getFirstToken(node, 1);

                if (node.init) {
                    offsets.setDesiredOffsets(node.init.range, forOpeningParen, 1);
                }
                if (node.test) {
                    offsets.setDesiredOffsets(node.test.range, forOpeningParen, 1);
                }
                if (node.update) {
                    offsets.setDesiredOffsets(node.update.range, forOpeningParen, 1);
                }
                addBlocklessNodeIndent(node.body);
            },

            "FunctionDeclaration, FunctionExpression"(node) {
                const closingParen = sourceCode.getTokenBefore(node.body);
                const openingParen = sourceCode.getTokenBefore(node.params.length ? node.params[0] : closingParen);

                parameterParens.add(openingParen);
                parameterParens.add(closingParen);
                addElementListIndent(node.params, openingParen, closingParen, options[node.type].parameters);
            },

            IfStatement(node) {
                addBlocklessNodeIndent(node.consequent);
                if (node.alternate && node.alternate.type !== "IfStatement") {
                    addBlocklessNodeIndent(node.alternate);
                }
            },

            ImportDeclaration(node) {
                if (node.specifiers.some(specifier => specifier.type === "ImportSpecifier")) {
                    const openingCurly = sourceCode.getFirstToken(node, astUtils.isOpeningBraceToken);
                    const closingCurly = sourceCode.getLastToken(node, astUtils.isClosingBraceToken);

                    addElementListIndent(node.specifiers.filter(specifier => specifier.type === "ImportSpecifier"), openingCurly, closingCurly, 1);
                }

                const fromToken = sourceCode.getLastToken(node, token => token.type === "Identifier" && token.value === "from");

                if (fromToken) {
                    offsets.setDesiredOffsets([fromToken.range[0], node.range[1]], sourceCode.getFirstToken(node), 1);
                }
            },

            "MemberExpression, JSXMemberExpression"(node) {
                const firstNonObjectToken = sourceCode.getFirstTokenBetween(node.object, node.property, astUtils.isNotClosingParenToken);
                const secondNonObjectToken = sourceCode.getTokenAfter(firstNonObjectToken);

                const objectParenCount = sourceCode.getTokensBetween(node.object, node.property, { filter: astUtils.isClosingParenToken }).length;
                const firstObjectToken = objectParenCount
                    ? sourceCode.getTokenBefore(node.object, { skip: objectParenCount - 1 })
                    : sourceCode.getFirstToken(node.object);
                const lastObjectToken = sourceCode.getTokenBefore(firstNonObjectToken);
                const firstPropertyToken = node.computed ? firstNonObjectToken : secondNonObjectToken;

                if (node.computed) {

                    // For computed MemberExpressions, match the closing bracket with the opening bracket.
                    offsets.matchIndentOf(firstNonObjectToken, sourceCode.getLastToken(node));
                    offsets.setDesiredOffsets(node.property.range, firstNonObjectToken, 1);
                }

                /*
                 * If the object ends on the same line that the property starts, match against the last token
                 * of the object, to ensure that the MemberExpression is not indented.
                 *
                 * Otherwise, match against the first token of the object, e.g.
                 * foo
                 *   .bar
                 *   .baz // <-- offset by 1 from `foo`
                 */
                const offsetBase = lastObjectToken.loc.end.line === firstPropertyToken.loc.start.line
                    ? lastObjectToken
                    : firstObjectToken;

                if (typeof options.MemberExpression === "number") {

                    // Match the dot (for non-computed properties) or the opening bracket (for computed properties) against the object.
                    offsets.setDesiredOffset(firstNonObjectToken, offsetBase, options.MemberExpression);

                    /*
                     * For computed MemberExpressions, match the first token of the property against the opening bracket.
                     * Otherwise, match the first token of the property against the object.
                     */
                    offsets.setDesiredOffset(secondNonObjectToken, node.computed ? firstNonObjectToken : offsetBase, options.MemberExpression);
                } else {

                    // If the MemberExpression option is off, ignore the dot and the first token of the property.
                    offsets.ignoreToken(firstNonObjectToken);
                    offsets.ignoreToken(secondNonObjectToken);

                    // To ignore the property indentation, ensure that the property tokens depend on the ignored tokens.
                    offsets.matchIndentOf(offsetBase, firstNonObjectToken);
                    offsets.matchIndentOf(firstNonObjectToken, secondNonObjectToken);
                }
            },

            NewExpression(node) {

                // Only indent the arguments if the NewExpression has parens (e.g. `new Foo(bar)` or `new Foo()`, but not `new Foo`
                if (node.arguments.length > 0 || astUtils.isClosingParenToken(sourceCode.getLastToken(node)) && astUtils.isOpeningParenToken(sourceCode.getLastToken(node, 1))) {
                    addFunctionCallIndent(node);
                }
            },

            ObjectExpression: addArrayOrObjectIndent,
            ObjectPattern: addArrayOrObjectIndent,

            Property(node) {
                if (!node.computed && !node.shorthand && !node.method && node.kind === "init") {
                    const colon = sourceCode.getFirstTokenBetween(node.key, node.value, astUtils.isColonToken);

                    offsets.ignoreToken(sourceCode.getTokenAfter(colon));
                }
            },

            SwitchStatement(node) {
                const openingCurly = sourceCode.getTokenAfter(node.discriminant, astUtils.isOpeningBraceToken);
                const closingCurly = sourceCode.getLastToken(node);
                const caseKeywords = node.cases.map(switchCase => sourceCode.getFirstToken(switchCase));

                offsets.setDesiredOffsets([openingCurly.range[1], closingCurly.range[0]], openingCurly, options.SwitchCase);

                node.cases.forEach((switchCase, index) => {
                    const caseKeyword = caseKeywords[index];

                    if (!(switchCase.consequent.length === 1 && switchCase.consequent[0].type === "BlockStatement")) {
                        const tokenAfterCurrentCase = index === node.cases.length - 1 ? closingCurly : caseKeywords[index + 1];

                        offsets.setDesiredOffsets([caseKeyword.range[1], tokenAfterCurrentCase.range[0]], caseKeyword, 1);
                    }
                });

                if (node.cases.length) {
                    sourceCode.getTokensBetween(
                        node.cases[node.cases.length - 1],
                        closingCurly,
                        { includeComments: true, filter: astUtils.isCommentToken }
                    ).forEach(token => offsets.ignoreToken(token));
                }
            },

            TemplateLiteral(node) {
                node.expressions.forEach((expression, index) => {
                    const previousQuasi = node.quasis[index];
                    const nextQuasi = node.quasis[index + 1];
                    const tokenToAlignFrom = previousQuasi.loc.start.line === previousQuasi.loc.end.line ? sourceCode.getFirstToken(previousQuasi) : null;

                    offsets.setDesiredOffsets([previousQuasi.range[1], nextQuasi.range[0]], tokenToAlignFrom, 1);
                    offsets.setDesiredOffset(sourceCode.getFirstToken(nextQuasi), tokenToAlignFrom, 0);
                });
            },

            VariableDeclaration(node) {
                const variableIndent = options.VariableDeclarator.hasOwnProperty(node.kind) ? options.VariableDeclarator[node.kind] : DEFAULT_VARIABLE_INDENT;

                if (node.declarations[node.declarations.length - 1].loc.start.line > node.loc.start.line) {

                    /*
                     * VariableDeclarator indentation is a bit different from other forms of indentation, in that the
                     * indentation of an opening bracket sometimes won't match that of a closing bracket. For example,
                     * the following indentations are correct:
                     *
                     * var foo = {
                     *   ok: true
                     * };
                     *
                     * var foo = {
                     *     ok: true,
                     *   },
                     *   bar = 1;
                     *
                     * Account for when exiting the AST (after indentations have already been set for the nodes in
                     * the declaration) by manually increasing the indentation level of the tokens in this declarator
                     * on the same line as the start of the declaration, provided that there are declarators that
                     * follow this one.
                     */
                    const firstToken = sourceCode.getFirstToken(node);

                    offsets.setDesiredOffsets(node.range, firstToken, variableIndent, true);
                } else {
                    offsets.setDesiredOffsets(node.range, sourceCode.getFirstToken(node), variableIndent);
                }
                const lastToken = sourceCode.getLastToken(node);

                if (astUtils.isSemicolonToken(lastToken)) {
                    offsets.ignoreToken(lastToken);
                }
            },

            VariableDeclarator(node) {
                if (node.init) {
                    const equalOperator = sourceCode.getTokenBefore(node.init, astUtils.isNotOpeningParenToken);
                    const tokenAfterOperator = sourceCode.getTokenAfter(equalOperator);

                    offsets.ignoreToken(equalOperator);
                    offsets.ignoreToken(tokenAfterOperator);
                    offsets.setDesiredOffsets([tokenAfterOperator.range[0], node.range[1]], equalOperator, 1);
                    offsets.matchIndentOf(sourceCode.getLastToken(node.id), equalOperator);
                }
            },

            WhileStatement: node => addBlocklessNodeIndent(node.body),

            "*:exit": checkForUnknownNode,

            "JSXAttribute[value]"(node) {
                const equalsToken = sourceCode.getFirstTokenBetween(node.name, node.value, token => token.type === "Punctuator" && token.value === "=");

                offsets.setDesiredOffsets([equalsToken.range[0], node.value.range[1]], sourceCode.getFirstToken(node.name), 1);
            },

            JSXElement(node) {
                if (node.closingElement) {
                    addElementListIndent(node.children, sourceCode.getFirstToken(node.openingElement), sourceCode.getFirstToken(node.closingElement), 1);
                }
            },

            JSXOpeningElement(node) {
                const firstToken = sourceCode.getFirstToken(node);
                let closingToken;

                if (node.selfClosing) {
                    closingToken = sourceCode.getLastToken(node, { skip: 1 });
                    offsets.matchIndentOf(closingToken, sourceCode.getLastToken(node));
                } else {
                    closingToken = sourceCode.getLastToken(node);
                }
                offsets.setDesiredOffsets(node.name.range, sourceCode.getFirstToken(node));
                addElementListIndent(node.attributes, firstToken, closingToken, 1);
            },

            JSXClosingElement(node) {
                const firstToken = sourceCode.getFirstToken(node);

                offsets.setDesiredOffsets(node.name.range, firstToken, 1);
                offsets.matchIndentOf(firstToken, sourceCode.getLastToken(node));
            },

            JSXExpressionContainer(node) {
                const openingCurly = sourceCode.getFirstToken(node);
                const closingCurly = sourceCode.getLastToken(node);

                offsets.setDesiredOffsets(
                    [openingCurly.range[1], closingCurly.range[0]],
                    openingCurly,
                    1
                );
                offsets.matchIndentOf(openingCurly, closingCurly);
            },

            "Program:exit"() {
                addParensIndent(sourceCode.ast.tokens);

                /*
                 * Create a Map from (tokenOrComment) => (precedingToken).
                 * This is necessary because sourceCode.getTokenBefore does not handle a comment as an argument correctly.
                 */
                const precedingTokens = sourceCode.ast.comments.reduce((commentMap, comment) => {
                    const tokenOrCommentBefore = sourceCode.getTokenBefore(comment, { includeComments: true });

                    return commentMap.set(comment, commentMap.has(tokenOrCommentBefore) ? commentMap.get(tokenOrCommentBefore) : tokenOrCommentBefore);
                }, new WeakMap());

                sourceCode.lines.forEach((line, lineIndex) => {
                    const lineNumber = lineIndex + 1;

                    if (!tokenInfo.firstTokensByLineNumber.has(lineNumber)) {

                        // Don't check indentation on blank lines
                        return;
                    }

                    const firstTokenOfLine = tokenInfo.firstTokensByLineNumber.get(lineNumber);

                    if (firstTokenOfLine.loc.start.line !== lineNumber) {

                        // Don't check the indentation of multi-line tokens (e.g. template literals or block comments) twice.
                        return;
                    }

                    // If the token matches the expected expected indentation, don't report it.
                    if (validateTokenIndent(firstTokenOfLine, offsets.getDesiredIndent(firstTokenOfLine))) {
                        return;
                    }

                    if (astUtils.isCommentToken(firstTokenOfLine)) {
                        const tokenBefore = precedingTokens.get(firstTokenOfLine);
                        const tokenAfter = tokenBefore ? sourceCode.getTokenAfter(tokenBefore) : sourceCode.ast.tokens[0];

                        // If a comment matches the expected indentation of the token immediately before or after, don't report it.
                        if (
                            tokenBefore && validateTokenIndent(firstTokenOfLine, offsets.getDesiredIndent(tokenBefore)) ||
                            tokenAfter && validateTokenIndent(firstTokenOfLine, offsets.getDesiredIndent(tokenAfter))
                        ) {
                            return;
                        }
                    }

                    // Otherwise, report the token/comment.
                    report(firstTokenOfLine, offsets.getDesiredIndent(firstTokenOfLine));
                });
            }

        };

    }
};

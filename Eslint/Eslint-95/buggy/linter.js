/**
 * @fileoverview Main Linter Class
 * @author Gyandeep Singh
 */

"use strict";

//------------------------------------------------------------------------------
// Requirements
//------------------------------------------------------------------------------

const EventEmitter = require("events").EventEmitter,
    eslintScope = require("eslint-scope"),
    levn = require("levn"),
    blankScriptAST = require("../conf/blank-script.json"),
    defaultConfig = require("../conf/default-config-options.js"),
    CodePathAnalyzer = require("./code-path-analysis/code-path-analyzer"),
    ConfigOps = require("./config/config-ops"),
    validator = require("./config/config-validator"),
    Environments = require("./config/environments"),
    applyDisableDirectives = require("./util/apply-disable-directives"),
    NodeEventGenerator = require("./util/node-event-generator"),
    SourceCode = require("./util/source-code"),
    Traverser = require("./util/traverser"),
    createReportTranslator = require("./report-translator"),
    Rules = require("./rules"),
    timing = require("./timing"),
    astUtils = require("./ast-utils"),
    pkg = require("../package.json"),
    SourceCodeFixer = require("./util/source-code-fixer");

const debug = require("debug")("eslint:linter");
const MAX_AUTOFIX_PASSES = 10;

//------------------------------------------------------------------------------
// Typedefs
//------------------------------------------------------------------------------

/**
 * The result of a parsing operation from parseForESLint()
 * @typedef {Object} CustomParseResult
 * @property {ASTNode} ast The ESTree AST Program node.
 * @property {Object} services An object containing additional services related
 *      to the parser.
 */

//------------------------------------------------------------------------------
// Helpers
//------------------------------------------------------------------------------

/**
 * Parses a list of "name:boolean_value" or/and "name" options divided by comma or
 * whitespace.
 * @param {string} string The string to parse.
 * @param {Comment} comment The comment node which has the string.
 * @returns {Object} Result map object of names and boolean values
 */
function parseBooleanConfig(string, comment) {
    const items = {};

    // Collapse whitespace around `:` and `,` to make parsing easier
    string = string.replace(/\s*([:,])\s*/g, "$1");

    string.split(/\s|,+/).forEach(name => {
        if (!name) {
            return;
        }
        const pos = name.indexOf(":");
        let value;

        if (pos !== -1) {
            value = name.slice(pos + 1);
            name = name.slice(0, pos);
        }

        items[name] = {
            value: (value === "true"),
            comment
        };

    });
    return items;
}

/**
 * Parses a JSON-like config.
 * @param {string} string The string to parse.
 * @param {Object} location Start line and column of comments for potential error message.
 * @returns {({success: true, config: Object}|{success: false, error: Problem})} Result map object
 */
function parseJsonConfig(string, location) {
    let items = {};

    // Parses a JSON-like comment by the same way as parsing CLI option.
    try {
        items = levn.parse("Object", string) || {};

        // Some tests say that it should ignore invalid comments such as `/*eslint no-alert:abc*/`.
        // Also, commaless notations have invalid severity:
        //     "no-alert: 2 no-console: 2" --> {"no-alert": "2 no-console: 2"}
        // Should ignore that case as well.
        if (ConfigOps.isEverySeverityValid(items)) {
            return {
                success: true,
                config: items
            };
        }
    } catch (ex) {

        // ignore to parse the string by a fallback.
    }

    // Optionator cannot parse commaless notations.
    // But we are supporting that. So this is a fallback for that.
    items = {};
    string = string.replace(/([a-zA-Z0-9\-/]+):/g, "\"$1\":").replace(/(]|[0-9])\s+(?=")/, "$1,");
    try {
        items = JSON.parse(`{${string}}`);
    } catch (ex) {
        return {
            success: false,
            error: {
                ruleId: null,
                fatal: true,
                severity: 2,
                source: null,
                message: `Failed to parse JSON from '${string}': ${ex.message}`,
                line: location.start.line,
                column: location.start.column + 1
            }
        };

    }

    return {
        success: true,
        config: items
    };
}

/**
 * Parses a config of values separated by comma.
 * @param {string} string The string to parse.
 * @returns {Object} Result map of values and true values
 */
function parseListConfig(string) {
    const items = {};

    // Collapse whitespace around ,
    string = string.replace(/\s*,\s*/g, ",");

    string.split(/,+/).forEach(name => {
        name = name.trim();
        if (!name) {
            return;
        }
        items[name] = true;
    });
    return items;
}

/**
 * Ensures that variables representing built-in properties of the Global Object,
 * and any globals declared by special block comments, are present in the global
 * scope.
 * @param {ASTNode} program The top node of the AST.
 * @param {Scope} globalScope The global scope.
 * @param {Object} config The existing configuration data.
 * @param {Environments} envContext Env context
 * @returns {void}
 */
function addDeclaredGlobals(program, globalScope, config, envContext) {
    const declaredGlobals = {},
        exportedGlobals = {},
        explicitGlobals = {},
        builtin = envContext.get("builtin");

    Object.assign(declaredGlobals, builtin);

    Object.keys(config.env).filter(name => config.env[name]).forEach(name => {
        const env = envContext.get(name),
            environmentGlobals = env && env.globals;

        if (environmentGlobals) {
            Object.assign(declaredGlobals, environmentGlobals);
        }
    });

    Object.assign(exportedGlobals, config.exported);
    Object.assign(declaredGlobals, config.globals);
    Object.assign(explicitGlobals, config.astGlobals);

    Object.keys(declaredGlobals).forEach(name => {
        let variable = globalScope.set.get(name);

        if (!variable) {
            variable = new eslintScope.Variable(name, globalScope);
            variable.eslintExplicitGlobal = false;
            globalScope.variables.push(variable);
            globalScope.set.set(name, variable);
        }
        variable.writeable = declaredGlobals[name];
    });

    Object.keys(explicitGlobals).forEach(name => {
        let variable = globalScope.set.get(name);

        if (!variable) {
            variable = new eslintScope.Variable(name, globalScope);
            variable.eslintExplicitGlobal = true;
            variable.eslintExplicitGlobalComment = explicitGlobals[name].comment;
            globalScope.variables.push(variable);
            globalScope.set.set(name, variable);
        }
        variable.writeable = explicitGlobals[name].value;
    });

    // mark all exported variables as such
    Object.keys(exportedGlobals).forEach(name => {
        const variable = globalScope.set.get(name);

        if (variable) {
            variable.eslintUsed = true;
        }
    });

    /*
     * "through" contains all references which definitions cannot be found.
     * Since we augment the global scope using configuration, we need to update
     * references and remove the ones that were added by configuration.
     */
    globalScope.through = globalScope.through.filter(reference => {
        const name = reference.identifier.name;
        const variable = globalScope.set.get(name);

        if (variable) {

            /*
             * Links the variable and the reference.
             * And this reference is removed from `Scope#through`.
             */
            reference.resolved = variable;
            variable.references.push(reference);

            return false;
        }

        return true;
    });
}

/**
 * Creates a collection of disable directives from a comment
 * @param {("disable"|"enable"|"disable-line"|"disable-next-line")} type The type of directive comment
 * @param {{line: number, column: number}} loc The 0-based location of the comment token
 * @param {string} value The value after the directive in the comment
 * comment specified no specific rules, so it applies to all rules (e.g. `eslint-disable`)
 * @returns {{
 *     type: ("disable"|"enable"|"disable-line"|"disable-next-line"),
 *     line: number,
 *     column: number,
 *     ruleId: (string|null)
 * }[]} Directives from the comment
 */
function createDisableDirectives(type, loc, value) {
    const ruleIds = Object.keys(parseListConfig(value));
    const directiveRules = ruleIds.length ? ruleIds : [null];

    return directiveRules.map(ruleId => ({ type, line: loc.line, column: loc.column + 1, ruleId }));
}

/**
 * Parses comments in file to extract file-specific config of rules, globals
 * and environments and merges them with global config; also code blocks
 * where reporting is disabled or enabled and merges them with reporting config.
 * @param {string} filename The file being checked.
 * @param {ASTNode} ast The top node of the AST.
 * @param {Object} config The existing configuration data.
 * @param {Linter} linterContext Linter context object
 * @returns {{
 *      config: Object,
 *      problems: Problem[],
 *      disableDirectives: {
 *          type: ("disable"|"enable"|"disable-line"|"disable-next-line"),
 *          line: number,
 *          column: number,
 *          ruleId: (string|null)
 *      }[]
 * }} Modified config object, along with any problems encountered
 * while parsing config comments
 */
function modifyConfigsFromComments(filename, ast, config, linterContext) {

    let commentConfig = {
        exported: {},
        astGlobals: {},
        rules: {},
        env: {}
    };
    const commentRules = {};
    const problems = [];
    const disableDirectives = [];

    ast.comments.filter(token => token.type !== "Shebang").forEach(comment => {

        let value = comment.value.trim();
        const match = /^(eslint(-\w+){0,3}|exported|globals?)(\s|$)/.exec(value);

        if (match) {
            value = value.slice(match.index + match[1].length);

            if (comment.type === "Block") {
                switch (match[1]) {
                    case "exported":
                        Object.assign(commentConfig.exported, parseBooleanConfig(value, comment));
                        break;

                    case "globals":
                    case "global":
                        Object.assign(commentConfig.astGlobals, parseBooleanConfig(value, comment));
                        break;

                    case "eslint-env":
                        Object.assign(commentConfig.env, parseListConfig(value));
                        break;

                    case "eslint-disable":
                        [].push.apply(disableDirectives, createDisableDirectives("disable", comment.loc.start, value));
                        break;

                    case "eslint-enable":
                        [].push.apply(disableDirectives, createDisableDirectives("enable", comment.loc.start, value));
                        break;

                    case "eslint": {
                        const parseResult = parseJsonConfig(value, comment.loc);

                        if (parseResult.success) {
                            Object.keys(parseResult.config).forEach(name => {
                                const ruleValue = parseResult.config[name];

                                validator.validateRuleOptions(name, ruleValue, `${filename} line ${comment.loc.start.line}`, linterContext.rules);
                                commentRules[name] = ruleValue;
                            });
                        } else {
                            problems.push(parseResult.error);
                        }

                        break;
                    }

                    // no default
                }
            } else { // comment.type === "Line"
                if (match[1] === "eslint-disable-line") {
                    [].push.apply(disableDirectives, createDisableDirectives("disable-line", comment.loc.start, value));
                } else if (match[1] === "eslint-disable-next-line") {
                    [].push.apply(disableDirectives, createDisableDirectives("disable-next-line", comment.loc.start, value));
                }
            }
        }
    });

    // apply environment configs
    Object.keys(commentConfig.env).forEach(name => {
        const env = linterContext.environments.get(name);

        if (env) {
            commentConfig = ConfigOps.merge(commentConfig, env);
        }
    });
    Object.assign(commentConfig.rules, commentRules);

    return {
        config: ConfigOps.merge(config, commentConfig),
        problems,
        disableDirectives
    };
}

/**
 * Normalize ECMAScript version from the initial config
 * @param  {number} ecmaVersion ECMAScript version from the initial config
 * @param  {boolean} isModule Whether the source type is module or not
 * @returns {number} normalized ECMAScript version
 */
function normalizeEcmaVersion(ecmaVersion, isModule) {

    // Need at least ES6 for modules
    if (isModule && (!ecmaVersion || ecmaVersion < 6)) {
        ecmaVersion = 6;
    }

    // Calculate ECMAScript edition number from official year version starting with
    // ES2015, which corresponds with ES6 (or a difference of 2009).
    if (ecmaVersion >= 2015) {
        ecmaVersion -= 2009;
    }

    return ecmaVersion;
}

/**
 * Process initial config to make it safe to extend by file comment config
 * @param  {Object} config Initial config
 * @param  {Environments} envContext Env context
 * @returns {Object}        Processed config
 */
function prepareConfig(config, envContext) {
    config.globals = config.globals || {};
    const copiedRules = {};
    let parserOptions = {};

    if (typeof config.rules === "object") {
        Object.keys(config.rules).forEach(k => {
            const rule = config.rules[k];

            if (rule === null) {
                throw new Error(`Invalid config for rule '${k}'.`);
            }
            if (Array.isArray(rule)) {
                copiedRules[k] = rule.slice();
            } else {
                copiedRules[k] = rule;
            }
        });
    }

    // merge in environment parserOptions
    if (typeof config.env === "object") {
        Object.keys(config.env).forEach(envName => {
            const env = envContext.get(envName);

            if (config.env[envName] && env && env.parserOptions) {
                parserOptions = ConfigOps.merge(parserOptions, env.parserOptions);
            }
        });
    }

    const preparedConfig = {
        rules: copiedRules,
        parser: config.parser || defaultConfig.parser,
        globals: ConfigOps.merge(defaultConfig.globals, config.globals),
        env: ConfigOps.merge(defaultConfig.env, config.env || {}),
        settings: ConfigOps.merge(defaultConfig.settings, config.settings || {}),
        parserOptions: ConfigOps.merge(parserOptions, config.parserOptions || {})
    };
    const isModule = preparedConfig.parserOptions.sourceType === "module";

    if (isModule) {

        // can't have global return inside of modules
        preparedConfig.parserOptions.ecmaFeatures = Object.assign({}, preparedConfig.parserOptions.ecmaFeatures, { globalReturn: false });
    }

    preparedConfig.parserOptions.ecmaVersion = normalizeEcmaVersion(preparedConfig.parserOptions.ecmaVersion, isModule);

    return preparedConfig;
}

const eslintEnvPattern = /\/\*\s*eslint-env\s(.+?)\*\//g;

/**
 * Checks whether or not there is a comment which has "eslint-env *" in a given text.
 * @param {string} text - A source code text to check.
 * @returns {Object|null} A result of parseListConfig() with "eslint-env *" comment.
 */
function findEslintEnv(text) {
    let match, retv;

    eslintEnvPattern.lastIndex = 0;

    while ((match = eslintEnvPattern.exec(text))) {
        retv = Object.assign(retv || {}, parseListConfig(match[1]));
    }

    return retv;
}

/**
 * Strips Unicode BOM from a given text.
 *
 * @param {string} text - A text to strip.
 * @returns {string} The stripped text.
 */
function stripUnicodeBOM(text) {

    /*
     * Check Unicode BOM.
     * In JavaScript, string data is stored as UTF-16, so BOM is 0xFEFF.
     * http://www.ecma-international.org/ecma-262/6.0/#sec-unicode-format-control-characters
     */
    if (text.charCodeAt(0) === 0xFEFF) {
        return text.slice(1);
    }
    return text;
}

/**
 * Get the options for a rule (not including severity), if any
 * @param {Array|number} ruleConfig rule configuration
 * @returns {Array} of rule options, empty Array if none
 */
function getRuleOptions(ruleConfig) {
    if (Array.isArray(ruleConfig)) {
        return ruleConfig.slice(1);
    }
    return [];

}

/**
 * Parses text into an AST. Moved out here because the try-catch prevents
 * optimization of functions, so it's best to keep the try-catch as isolated
 * as possible
 * @param {string} text The text to parse.
 * @param {Object} providedParserOptions Options to pass to the parser
 * @param {string} parserName The name of the parser
 * @param {string} filePath The path to the file being parsed.
 * @returns {{success: false, error: Problem}|{success: true,ast: ASTNode, services: Object}}
 * An object containing the AST and parser services if parsing was successful, or the error if parsing failed
 * @private
 */
function parse(text, providedParserOptions, parserName, filePath) {

    const parserOptions = Object.assign({}, providedParserOptions, {
        loc: true,
        range: true,
        raw: true,
        tokens: true,
        comment: true,
        filePath
    });

    let parser;

    try {
        parser = require(parserName);
    } catch (ex) {
        return {
            success: false,
            error: {
                ruleId: null,
                fatal: true,
                severity: 2,
                source: null,
                message: ex.message,
                line: 0,
                column: 0
            }
        };
    }

    /*
     * Check for parsing errors first. If there's a parsing error, nothing
     * else can happen. However, a parsing error does not throw an error
     * from this method - it's just considered a fatal error message, a
     * problem that ESLint identified just like any other.
     */
    try {
        if (typeof parser.parseForESLint === "function") {
            const parseResult = parser.parseForESLint(text, parserOptions);

            return {
                success: true,
                ast: parseResult.ast,
                services: parseResult.services || {}
            };
        }

        return {
            success: true,
            ast: parser.parse(text, parserOptions),
            services: {}
        };
    } catch (ex) {

        // If the message includes a leading line number, strip it:
        const message = `Parsing error: ${ex.message.replace(/^line \d+:/i, "").trim()}`;
        const source = ex.lineNumber ? SourceCode.splitLines(text)[ex.lineNumber - 1] : null;

        return {
            success: false,
            error: {
                ruleId: null,
                fatal: true,
                severity: 2,
                source,
                message,
                line: ex.lineNumber,
                column: ex.column
            }
        };
    }
}

/**
 * Gets the scope for the current node
 * @param {ScopeManager} scopeManager The scope manager for this AST
 * @param {ASTNode} currentNode The node to get the scope of
 * @param {number} ecmaVersion The `ecmaVersion` setting that this code was parsed with
 * @returns {eslint-scope.Scope} The scope information for this node
 */
function getScope(scopeManager, currentNode, ecmaVersion) {
    let initialNode;

    // if current node introduces a scope, add it to the list
    if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].indexOf(currentNode.type) >= 0 ||
        ecmaVersion >= 6 && ["BlockStatement", "SwitchStatement", "CatchClause"].indexOf(currentNode.type) >= 0
    ) {
        initialNode = currentNode;
    } else {
        initialNode = currentNode.parent;
    }

    // Ascend the current node's parents
    for (let node = initialNode; node; node = node.parent) {

        // Get the innermost scope
        const scope = scopeManager.acquire(node, true);

        if (scope) {
            if (scope.type === "function-expression-name") {
                return scope.childScopes[0];
            }
            return scope;
        }
    }

    return scopeManager.scopes[0];
}

// methods that exist on SourceCode object
const DEPRECATED_SOURCECODE_PASSTHROUGHS = {
    getSource: "getText",
    getSourceLines: "getLines",
    getAllComments: "getAllComments",
    getNodeByRangeIndex: "getNodeByRangeIndex",
    getComments: "getComments",
    getCommentsBefore: "getCommentsBefore",
    getCommentsAfter: "getCommentsAfter",
    getCommentsInside: "getCommentsInside",
    getJSDocComment: "getJSDocComment",
    getFirstToken: "getFirstToken",
    getFirstTokens: "getFirstTokens",
    getLastToken: "getLastToken",
    getLastTokens: "getLastTokens",
    getTokenAfter: "getTokenAfter",
    getTokenBefore: "getTokenBefore",
    getTokenByRangeStart: "getTokenByRangeStart",
    getTokens: "getTokens",
    getTokensAfter: "getTokensAfter",
    getTokensBefore: "getTokensBefore",
    getTokensBetween: "getTokensBetween"
};

const BASE_TRAVERSAL_CONTEXT = Object.freeze(
    Object.keys(DEPRECATED_SOURCECODE_PASSTHROUGHS).reduce(
        (contextInfo, methodName) =>
            Object.assign(contextInfo, {
                [methodName]() {
                    const sourceCode = this.getSourceCode();

                    return sourceCode[DEPRECATED_SOURCECODE_PASSTHROUGHS[methodName]].apply(sourceCode, arguments);
                }
            }),
        {}
    )
);

//------------------------------------------------------------------------------
// Public Interface
//------------------------------------------------------------------------------

/**
 * Object that is responsible for verifying JavaScript text
 * @name eslint
 */
module.exports = class Linter {

    constructor() {
        this.currentConfig = null;
        this.scopeManager = null;
        this.traverser = null;
        this.sourceCode = null;
        this.version = pkg.version;

        this.rules = new Rules();
        this.environments = new Environments();
    }

    /**
     * Resets the internal state of the object.
     * @returns {void}
     */
    reset() {
        this.currentConfig = null;
        this.scopeManager = null;
        this.traverser = null;
        this.sourceCode = null;
    }

    /**
     * Configuration object for the `verify` API. A JS representation of the eslintrc files.
     * @typedef {Object} ESLintConfig
     * @property {Object} rules The rule configuration to verify against.
     * @property {string} [parser] Parser to use when generatig the AST.
     * @property {Object} [parserOptions] Options for the parsed used.
     * @property {Object} [settings] Global settings passed to each rule.
     * @property {Object} [env] The environment to verify in.
     * @property {Object} [globals] Available globals to the code.
     */

    /**
     * Verifies the text against the rules specified by the second argument.
     * @param {string|SourceCode} textOrSourceCode The text to parse or a SourceCode object.
     * @param {ESLintConfig} config An ESLintConfig instance to configure everything.
     * @param {(string|Object)} [filenameOrOptions] The optional filename of the file being checked.
     *      If this is not set, the filename will default to '<input>' in the rule context. If
     *      an object, then it has "filename", "saveState", and "allowInlineConfig" properties.
     * @param {boolean} [saveState] Indicates if the state from the last run should be saved.
     *      Mostly useful for testing purposes.
     * @param {boolean} [filenameOrOptions.allowInlineConfig] Allow/disallow inline comments' ability to change config once it is set. Defaults to true if not supplied.
     *      Useful if you want to validate JS without comments overriding rules.
     * @returns {Object[]} The results as an array of messages or null if no messages.
     */
    verify(textOrSourceCode, config, filenameOrOptions, saveState) {
        let text,
            parserServices,
            allowInlineConfig;

        if (typeof textOrSourceCode === "string") {
            this.sourceCode = null;
            text = textOrSourceCode;
        } else {
            this.sourceCode = textOrSourceCode;
            text = this.sourceCode.text;
        }

        let providedFilename;

        // evaluate arguments
        if (typeof filenameOrOptions === "object") {
            providedFilename = filenameOrOptions.filename;
            allowInlineConfig = filenameOrOptions.allowInlineConfig;
            saveState = filenameOrOptions.saveState;
        } else {
            providedFilename = filenameOrOptions;
        }

        const filename = typeof providedFilename === "string" ? providedFilename : "<input>";

        if (!saveState) {
            this.reset();
        }

        // search and apply "eslint-env *".
        const envInFile = findEslintEnv(text);

        config = Object.assign({}, config);

        if (envInFile) {
            if (config.env) {
                config.env = Object.assign({}, config.env, envInFile);
            } else {
                config.env = envInFile;
            }
        }

        // process initial config to make it safe to extend
        config = prepareConfig(config, this.environments);

        if (this.sourceCode) {
            parserServices = {};
        } else {

            // there's no input, just exit here
            if (text.trim().length === 0) {
                this.sourceCode = new SourceCode(text, blankScriptAST);
                return [];
            }

            const parseResult = parse(
                stripUnicodeBOM(text).replace(astUtils.SHEBANG_MATCHER, (match, captured) => `//${captured}`),
                config.parserOptions,
                config.parser,
                filename
            );

            if (!parseResult.success) {
                return [parseResult.error];
            }

            parserServices = parseResult.services;
            this.sourceCode = new SourceCode(text, parseResult.ast);
        }

        const problems = [];
        const sourceCode = this.sourceCode;
        let disableDirectives;

        // parse global comments and modify config
        if (allowInlineConfig !== false) {
            const modifyConfigResult = modifyConfigsFromComments(filename, sourceCode.ast, config, this);

            config = modifyConfigResult.config;
            modifyConfigResult.problems.forEach(problem => problems.push(problem));
            disableDirectives = modifyConfigResult.disableDirectives;
        } else {
            disableDirectives = [];
        }

        const emitter = new EventEmitter().setMaxListeners(Infinity);

        /*
         * Create a frozen object with the ruleContext properties and methods that are shared by all rules.
         * All rule contexts will inherit from this object. This avoids the performance penalty of copying all the
         * properties once for each rule.
         */
        const sharedTraversalContext = Object.freeze(
            Object.assign(
                Object.create(BASE_TRAVERSAL_CONTEXT),
                {
                    getAncestors: () => this.traverser.parents(),
                    getDeclaredVariables: node => this.scopeManager && this.scopeManager.getDeclaredVariables(node) || [],
                    getFilename: () => filename,
                    getScope: () => getScope(this.scopeManager, this.traverser.current(), this.currentConfig.parserOptions.ecmaVersion),
                    getSourceCode: () => sourceCode,
                    markVariableAsUsed: this.markVariableAsUsed.bind(this),
                    parserOptions: config.parserOptions,
                    parserPath: config.parser,
                    parserServices,
                    settings: config.settings,

                    /**
                     * This is used to avoid breaking rules that used to monkeypatch the `Linter#report` method
                     * by using the `_linter` property on rule contexts.
                     *
                     * This should be removed in a major release after we create a better way to
                     * lint for unused disable comments.
                     * https://github.com/eslint/eslint/issues/9193
                     */
                    _linter: {
                        report() {},
                        on: emitter.on.bind(emitter)
                    }
                }
            )
        );

        // enable appropriate rules
        Object.keys(config.rules).forEach(ruleId => {
            const severity = ConfigOps.getRuleSeverity(config.rules[ruleId]);

            if (severity === 0) {
                return;
            }

            const rule = this.rules.get(ruleId);
            let reportTranslator = null;
            const ruleContext = Object.freeze(
                Object.assign(
                    Object.create(sharedTraversalContext),
                    {
                        id: ruleId,
                        options: getRuleOptions(config.rules[ruleId]),
                        report() {

                            /*
                             * Create a report translator lazily.
                             * In a vast majority of cases, any given rule reports zero errors on a given
                             * piece of code. Creating a translator lazily avoids the performance cost of
                             * creating a new translator function for each rule that usually doesn't get
                             * called.
                             *
                             * Using lazy report translators improves end-to-end performance by about 3%
                             * with Node 8.4.0.
                             */
                            if (reportTranslator === null) {
                                reportTranslator = createReportTranslator({ ruleId, severity, sourceCode });
                            }
                            const problem = reportTranslator.apply(null, arguments);

                            if (problem.fix && rule.meta && !rule.meta.fixable) {
                                throw new Error("Fixable rules should export a `meta.fixable` property.");
                            }
                            problems.push(problem);

                            /*
                             * This is used to avoid breaking rules that used monkeypatch Linter, and relied on
                             * `linter.report` getting called with report info every time a rule reports a problem.
                             * To continue to support this, make sure that `context._linter.report` is called every
                             * time a problem is reported by a rule, even though `context._linter` is no longer a
                             * `Linter` instance.
                             *
                             * This should be removed in a major release after we create a better way to
                             * lint for unused disable comments.
                             * https://github.com/eslint/eslint/issues/9193
                             */
                            sharedTraversalContext._linter.report( // eslint-disable-line no-underscore-dangle
                                problem.ruleId,
                                problem.severity,
                                { loc: { start: { line: problem.line, column: problem.column - 1 } } },
                                problem.message
                            );
                        }
                    }
                )
            );

            try {
                const ruleListeners = rule.create(ruleContext);

                // add all the selectors from the rule as listeners
                Object.keys(ruleListeners).forEach(selector => {
                    emitter.on(
                        selector,
                        timing.enabled
                            ? timing.time(ruleId, ruleListeners[selector])
                            : ruleListeners[selector]
                    );
                });
            } catch (ex) {
                ex.message = `Error while loading rule '${ruleId}': ${ex.message}`;
                throw ex;
            }
        });

        // save config so rules can access as necessary
        this.currentConfig = config;
        this.traverser = new Traverser();

        const ecmaFeatures = this.currentConfig.parserOptions.ecmaFeatures || {};
        const ecmaVersion = this.currentConfig.parserOptions.ecmaVersion || 5;

        // gather scope data that may be needed by the rules
        this.scopeManager = eslintScope.analyze(sourceCode.ast, {
            ignoreEval: true,
            nodejsScope: ecmaFeatures.globalReturn,
            impliedStrict: ecmaFeatures.impliedStrict,
            ecmaVersion,
            sourceType: this.currentConfig.parserOptions.sourceType || "script",
            fallback: Traverser.getKeys
        });

        // augment global scope with declared global variables
        addDeclaredGlobals(sourceCode.ast, this.scopeManager.scopes[0], this.currentConfig, this.environments);

        const eventGenerator = new CodePathAnalyzer(new NodeEventGenerator(emitter));

        /*
         * Each node has a type property. Whenever a particular type of
         * node is found, an event is fired. This allows any listeners to
         * automatically be informed that this type of node has been found
         * and react accordingly.
         */
        this.traverser.traverse(sourceCode.ast, {
            enter(node, parent) {
                node.parent = parent;
                eventGenerator.enterNode(node);
            },
            leave(node) {
                eventGenerator.leaveNode(node);
            }
        });

        return applyDisableDirectives({
            directives: disableDirectives,
            problems: problems.sort((problemA, problemB) => problemA.line - problemB.line || problemA.column - problemB.column)
        });
    }

    /**
     * Gets the SourceCode object representing the parsed source.
     * @returns {SourceCode} The SourceCode object.
     */
    getSourceCode() {
        return this.sourceCode;
    }

    /**
     * Record that a particular variable has been used in code
     * @param {string} name The name of the variable to mark as used
     * @returns {boolean} True if the variable was found and marked as used,
     *      false if not.
     */
    markVariableAsUsed(name) {
        const hasGlobalReturn = this.currentConfig.parserOptions.ecmaFeatures && this.currentConfig.parserOptions.ecmaFeatures.globalReturn,
            specialScope = hasGlobalReturn || this.currentConfig.parserOptions.sourceType === "module";
        let scope = getScope(this.scopeManager, this.traverser.current(), this.currentConfig.parserOptions.ecmaVersion);

        // Special Node.js scope means we need to start one level deeper
        if (scope.type === "global" && specialScope) {
            scope = scope.childScopes[0];
        }

        do {
            const variables = scope.variables;

            for (let i = 0; i < variables.length; i++) {
                if (variables[i].name === name) {
                    variables[i].eslintUsed = true;
                    return true;
                }
            }
        } while ((scope = scope.upper));

        return false;
    }

    /**
     * Defines a new linting rule.
     * @param {string} ruleId A unique rule identifier
     * @param {Function} ruleModule Function from context to object mapping AST node types to event handlers
     * @returns {void}
     */
    defineRule(ruleId, ruleModule) {
        this.rules.define(ruleId, ruleModule);
    }

    /**
     * Defines many new linting rules.
     * @param {Object} rulesToDefine map from unique rule identifier to rule
     * @returns {void}
     */
    defineRules(rulesToDefine) {
        Object.getOwnPropertyNames(rulesToDefine).forEach(ruleId => {
            this.defineRule(ruleId, rulesToDefine[ruleId]);
        });
    }

    /**
     * Gets an object with all loaded rules.
     * @returns {Map} All loaded rules
     */
    getRules() {
        return this.rules.getAllLoadedRules();
    }

    /**
     * Performs multiple autofix passes over the text until as many fixes as possible
     * have been applied.
     * @param {string} text The source text to apply fixes to.
     * @param {Object} config The ESLint config object to use.
     * @param {Object} options The ESLint options object to use.
     * @param {string} options.filename The filename from which the text was read.
     * @param {boolean} options.allowInlineConfig Flag indicating if inline comments
     *      should be allowed.
     * @param {boolean|Function} options.fix Determines whether fixes should be applied
     * @returns {Object} The result of the fix operation as returned from the
     *      SourceCodeFixer.
     */
    verifyAndFix(text, config, options) {
        let messages = [],
            fixedResult,
            fixed = false,
            passNumber = 0;
        const debugTextDescription = options && options.filename || `${text.slice(0, 10)}...`;
        const shouldFix = options && typeof options.fix !== "undefined" ? options.fix : true;

        /**
         * This loop continues until one of the following is true:
         *
         * 1. No more fixes have been applied.
         * 2. Ten passes have been made.
         *
         * That means anytime a fix is successfully applied, there will be another pass.
         * Essentially, guaranteeing a minimum of two passes.
         */
        do {
            passNumber++;

            debug(`Linting code for ${debugTextDescription} (pass ${passNumber})`);
            messages = this.verify(text, config, options);

            debug(`Generating fixed text for ${debugTextDescription} (pass ${passNumber})`);
            fixedResult = SourceCodeFixer.applyFixes(text, messages, shouldFix);

            // stop if there are any syntax errors.
            // 'fixedResult.output' is a empty string.
            if (messages.length === 1 && messages[0].fatal) {
                break;
            }

            // keep track if any fixes were ever applied - important for return value
            fixed = fixed || fixedResult.fixed;

            // update to use the fixed output instead of the original text
            text = fixedResult.output;

        } while (
            fixedResult.fixed &&
            passNumber < MAX_AUTOFIX_PASSES
        );

        /*
         * If the last result had fixes, we need to lint again to be sure we have
         * the most up-to-date information.
         */
        if (fixedResult.fixed) {
            fixedResult.messages = this.verify(text, config, options);
        }

        // ensure the last result properly reflects if fixes were done
        fixedResult.fixed = fixed;
        fixedResult.output = text;

        return fixedResult;
    }
};

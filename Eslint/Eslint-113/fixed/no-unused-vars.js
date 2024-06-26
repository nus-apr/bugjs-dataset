/**
 * @fileoverview Rule to flag declared but unused variables
 * @author Ilya Volodin
 */

"use strict";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = function(context) {

    var allowUnusedGlobals = context.options[0] === "all" ? false : true;

    var variables = [];

    function populateVariables(node) {
        var scope = context.getScope(),
            functionName = node && node.id && node.id.name,
            parent = context.getAncestors().pop(),

            // check for function foo(){}.bind(this)
            functionNameUsed = parent && parent.type === "MemberExpression" && parent.property.name === "bind";

        scope.variables.forEach(function(variable) {
            //filter out global variables that we add as part of eslint or arguments variable
            if (variable.identifiers.length > 0) {
                //make sure that this variable is not already in the array
                if (!variables.some(function(storedVariable) {
                    return storedVariable.name === variable.name && storedVariable.node === variable.identifiers[0];
                })) {

                    variables.push({
                        name: variable.name,
                        node: variable.identifiers[0],
                        used: (variable.name === functionName) && functionNameUsed
                    });
                }
            }
        });
    }

    function populateGlobalVariables() {
        if (!allowUnusedGlobals) {
            populateVariables();
        }
    }

    function findVariable(name) {
        var scope = context.getScope();
        var scopeVariable = [];
        function filter(variable) {
            return variable.name === name;
        }
        while (scopeVariable.length === 0) {
            scopeVariable = scope.variables.filter(filter);
            if (scopeVariable.length === 0) {
                if (!scope.upper) {
                    return null;
                }
                scope = scope.upper;
            }
        }
        return variables.filter(function(variable) {
            return variable.name === scopeVariable[0].name && scopeVariable[0].identifiers.some(function(identifier) {
                return variable.node === identifier;
            });
        })[0];
    }

    function isFunction(node) {
        return node && node.type && (node.type === "FunctionDeclaration" || node.type === "FunctionExpression");
    }

    function findFirstAncestorThatIsFunctionExpressionOrDeclaration(ancestors) {
        var currentAncestor;
        while (ancestors.length !== 0 && !isFunction(currentAncestor)) {
            currentAncestor = ancestors.pop();
        }
        return isFunction(currentAncestor) ? currentAncestor : undefined;
    }

    function markIgnorableUnusedVariables(usedVariable, ancestors) {
        /* When variables are declared as parameters in a FunctionExpression or
         * FunctionDeclaration, they can go unused so long as at least one
         * to the right of them is used.
         */

        // Find the FunctionExpressions and FunctionDeclarations in which this used variable
        // may be a parameter
        var ancestorFunctionNode = findFirstAncestorThatIsFunctionExpressionOrDeclaration(ancestors);
        if (ancestorFunctionNode) {
            // Get a list of the param names used in the ancestor Function
            var fnParamNames = ancestorFunctionNode.params.map(function(param){
                return param.name;
            });
            // Check if the used variable exists among those params
            var variableIndex = fnParamNames.indexOf(usedVariable.name);
            // This will be true if this variable appears in the param list of an ancestor Function Expression
            // or FunctionDeclaration.
            if (variableIndex !== -1) {
                // All params left of the used variables are ignorable.
                var ignorableVariables = fnParamNames.slice(0, variableIndex);
                // Mark them as ignorable.
                ignorableVariables.forEach(function(ignorableVariable){
                    variables.forEach(function(variable){
                        if (variable.name === ignorableVariable) {
                            variable.ignorable = true;
                        }
                    });
                });
            }
        }
    }

    return {
        "FunctionDeclaration": populateVariables,
        "FunctionExpression": populateVariables,
        "Program": populateGlobalVariables,
        "Identifier": function(node) {
            var ancestors = context.getAncestors(node);
            var parent = ancestors.pop();
            var grandparent = ancestors.pop();
            /*if it's not an assignment expression find corresponding
              *variable in the array and mark it as used
              */
            if ((parent.type !== "AssignmentExpression" || node !== parent.left) &&
                (parent.type !== "VariableDeclarator" || (parent.init && parent.init === node)) &&
                parent.type !== "FunctionDeclaration" &&
                (parent.type !== "FunctionExpression" ||
                (grandparent !== null && (grandparent.type === "CallExpression" || grandparent.type === "AssignmentExpression")))) {

                var variable = findVariable(node.name);
                if (variable) {
                    variable.used = true;
                    markIgnorableUnusedVariables(variable, ancestors);
                }

            }
        },
        "Program:after": function() {
            var unused = variables.filter(function(variable) {
                return !variable.used && !variable.ignorable;
            });
            unused.forEach(function(variable) {
                context.report(variable.node, "{{var}} is defined but never used", {"var": variable.name});
            });
        }
    };

};

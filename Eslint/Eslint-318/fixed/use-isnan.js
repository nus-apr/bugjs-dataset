/**
 * @fileoverview Rule to flag comparisons to the value NaN
 * @author James Allardice
 * @copyright 2014 Jordan Harband. All rights reserved.
 * @copyright 2013 James Allardice. All rights reserved.
 */

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = function (context) {

    "use strict";

    return {
        "BinaryExpression": function (node) {
            if (/^[<>]=?|^===?|^!==?$/.test(node.operator) && (node.left.name === "NaN" || node.right.name === "NaN")) {
                context.report(node, "Use the isNaN function to compare with NaN.");
            }
        }
    };

};

// The JS reader of the FOP contract schema language
// (tests/fixtures/cost_basis_fop/contract/protocol.json, "schemaLanguage").
//
// tests/cost_basis_fop_contract_test.py holds an independent Python reader and
// runs this file as a CLI to prove both readers report exactly the same
// errors for every example:
//
//   node tests/helpers/fop-contract-schema.js <contract.json>
//
// prints {"valid": {name: errors}, "invalid": {name: errors}} as JSON.
const fs = require('node:fs');

function joinPath(base, key) {
    return base ? `${base}.${key}` : key;
}

function isPresent(object, field) {
    return Object.prototype.hasOwnProperty.call(object, field) && object[field] !== null;
}

function sameValue(left, right) {
    if (typeof left === 'boolean' || typeof right === 'boolean') {
        return typeof left === typeof right && left === right;
    }
    return left === right;
}

function createChecker(types) {
    function resolve(spec) {
        let current = spec;
        const seen = new Set();
        while (current.ref !== undefined) {
            if (seen.has(current.ref) || !types[current.ref]) {
                throw new Error(`unknown or circular type ${current.ref}`);
            }
            seen.add(current.ref);
            current = types[current.ref];
        }
        return current;
    }

    function allowsNull(spec) {
        let current = spec;
        while (true) {
            if (current.nullable === true) return true;
            if (current.ref === undefined) return false;
            current = types[current.ref];
        }
    }

    function check(spec, value, path, errors) {
        const resolved = resolve(spec);
        if (resolved.type === 'json') return;
        if (resolved.type === 'const') {
            if (!sameValue(value, resolved.value)) errors.push({ path, code: 'const' });
            return;
        }
        if (value === null) {
            if (!allowsNull(spec)) errors.push({ path, code: 'null' });
            return;
        }
        switch (resolved.type) {
        case 'string':
            if (typeof value !== 'string') {
                errors.push({ path, code: 'type' });
                return;
            }
            if (resolved.enum && resolved.enum.indexOf(value) < 0) errors.push({ path, code: 'enum' });
            if (resolved.pattern && !new RegExp(resolved.pattern).test(value)) {
                errors.push({ path, code: 'pattern' });
            }
            if (resolved.minLength !== undefined && value.length < resolved.minLength) {
                errors.push({ path, code: 'minLength' });
            }
            return;
        case 'integer':
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)
                || (resolved.type === 'integer' && !Number.isInteger(value))) {
                errors.push({ path, code: 'type' });
                return;
            }
            if (resolved.min !== undefined && value < resolved.min) errors.push({ path, code: 'min' });
            if (resolved.exclusiveMin !== undefined && value <= resolved.exclusiveMin) {
                errors.push({ path, code: 'min' });
            }
            if (resolved.max !== undefined && value > resolved.max) errors.push({ path, code: 'max' });
            if (resolved.nonzero && value === 0) errors.push({ path, code: 'nonzero' });
            return;
        case 'boolean':
            if (typeof value !== 'boolean') errors.push({ path, code: 'type' });
            return;
        case 'array':
            if (!Array.isArray(value)) {
                errors.push({ path, code: 'type' });
                return;
            }
            if (resolved.minItems !== undefined && value.length < resolved.minItems) {
                errors.push({ path, code: 'minItems' });
            }
            if (resolved.maxItems !== undefined && value.length > resolved.maxItems) {
                errors.push({ path, code: 'maxItems' });
            }
            value.forEach((item, index) => check(resolved.items, item, `${path}[${index}]`, errors));
            return;
        case 'map': {
            if (typeof value !== 'object' || Array.isArray(value)) {
                errors.push({ path, code: 'type' });
                return;
            }
            const keys = Object.keys(value);
            if (resolved.minEntries !== undefined && keys.length < resolved.minEntries) {
                errors.push({ path, code: 'minEntries' });
            }
            keys.forEach((key) => check(resolved.values, value[key], joinPath(path, key), errors));
            return;
        }
        case 'variant': {
            if (typeof value !== 'object' || Array.isArray(value)) {
                errors.push({ path, code: 'type' });
                return;
            }
            const key = value[resolved.on];
            const chosen = typeof key === 'string' ? resolved.cases[key] : undefined;
            if (!chosen) {
                errors.push({ path: joinPath(path, resolved.on), code: 'variant' });
                return;
            }
            check(chosen, value, path, errors);
            return;
        }
        case 'object':
            checkObject(resolved, value, path, errors);
            return;
        default:
            throw new Error(`unknown spec type ${resolved.type}`);
        }
    }

    function checkObject(spec, value, path, errors) {
        if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push({ path, code: 'type' });
            return;
        }
        Object.keys(value).forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) {
                errors.push({ path: joinPath(path, key), code: 'additional' });
            }
        });
        (spec.required || []).forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                errors.push({ path: joinPath(path, key), code: 'missing' });
            }
        });
        Object.keys(spec.fields).forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(value, key)) {
                check(spec.fields[key], value[key], joinPath(path, key), errors);
            }
        });
        (spec.rules || []).forEach((rule) => {
            if (!ruleHolds(rule, value, spec)) errors.push({ path, code: `rule:${rule.id}` });
        });
    }

    // A malformed value already reports its own error; ordering it as text
    // would add a second, misleading one.
    function wellFormed(spec, value) {
        const errors = [];
        check(spec, value, '', errors);
        return errors.length === 0;
    }

    function ruleHolds(rule, value, spec) {
        if (rule.when) {
            const actual = Object.prototype.hasOwnProperty.call(value, rule.when.field)
                ? value[rule.when.field] : undefined;
            if (actual === undefined || !rule.when.in.some((candidate) => sameValue(actual, candidate))) {
                return true;
            }
        }
        if (rule.require && !rule.require.every((field) => isPresent(value, field))) return false;
        if (rule.forbid && rule.forbid.some((field) => isPresent(value, field))) return false;
        if (rule.sign) {
            const failed = Object.keys(rule.sign).some((field) => {
                const number = value[field];
                if (typeof number !== 'number') return false;
                return rule.sign[field] === 'positive' ? !(number > 0) : !(number < 0);
            });
            if (failed) return false;
        }
        if (rule.exactlyOne
            && rule.exactlyOne.filter((field) => isPresent(value, field)).length !== 1) {
            return false;
        }
        if (rule.equals) {
            const left = value[rule.equals.field];
            const right = value[rule.equals.negate];
            if (typeof left === 'number' && typeof right === 'number'
                && Math.abs(left + right) > 1e-9) {
                return false;
            }
        }
        if (rule.lessOrEqual) {
            const [first, second] = rule.lessOrEqual;
            if (isPresent(value, first) && isPresent(value, second)
                && wellFormed(spec.fields[first], value[first])
                && wellFormed(spec.fields[second], value[second])
                && value[first] > value[second]) {
                return false;
            }
        }
        return true;
    }

    return {
        check(typeName, value) {
            if (!types[typeName]) throw new Error(`unknown type ${typeName}`);
            const errors = [];
            check({ ref: typeName }, value, '', errors);
            return errors;
        },
    };
}

function validateDocument(document) {
    const checker = createChecker(document.types);
    const result = { valid: {}, invalid: {} };
    ['valid', 'invalid'].forEach((group) => {
        document.examples[group].forEach((example) => {
            result[group][example.name] = checker.check(example.type, example.value);
        });
    });
    return result;
}

module.exports = { createChecker, validateDocument };

if (require.main === module) {
    const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(validateDocument(document)));
}

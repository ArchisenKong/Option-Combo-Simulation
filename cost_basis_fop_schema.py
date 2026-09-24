"""Runtime reader of the FOP protocol contract (CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §13.3 P1-P2).

The server checks every FOP request against the frozen message types before
any domain rule runs, so a payload the contract refuses never reaches the
ledger. The types come from cost_basis_fop_protocol.json, a runtime copy of
the "types" and "formats" of tests/fixtures/cost_basis_fop/contract/
protocol.json; tests/cost_basis_fop_contract_test.py fails when the two
differ. The schema language is described in that fixture ("schemaLanguage").

This reader and the JS one in tests/helpers/fop-contract-schema.js are
written independently and must report exactly the same errors for every
contract example.
"""
import json
import math
import pathlib
import re

PROTOCOL_PATH = pathlib.Path(__file__).with_name('cost_basis_fop_protocol.json')


def _same(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if left is None or right is None:
        return left is right
    return left == right


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _present(value, field):
    return field in value and value[field] is not None


class ContractReader:
    def __init__(self, types):
        self.types = types
        self._patterns = {}

    def _resolve(self, spec):
        seen = set()
        while 'ref' in spec:
            name = spec['ref']
            if name in seen or name not in self.types:
                raise KeyError(f'unknown or circular type {name}')
            seen.add(name)
            spec = self.types[name]
        return spec

    def _nullable(self, spec):
        while True:
            if spec.get('nullable') is True:
                return True
            if 'ref' not in spec:
                return False
            spec = self.types[spec['ref']]

    def _pattern(self, pattern):
        if pattern not in self._patterns:
            # JS '$' only matches at the very end; Python's also before a
            # final newline. '\Z' gives the JS meaning.
            text = pattern[:-1] + r'\Z' if pattern.endswith('$') else pattern
            self._patterns[pattern] = re.compile(text, re.ASCII)
        return self._patterns[pattern]

    def check(self, type_name, value):
        if type_name not in self.types:
            raise KeyError(type_name)
        errors = []
        self._check({'ref': type_name}, value, '', errors)
        return errors

    def _check(self, spec, value, path, errors):
        resolved = self._resolve(spec)
        kind = resolved['type']
        if kind == 'json':
            return
        if kind == 'const':
            if not _same(value, resolved['value']):
                errors.append((path, 'const'))
            return
        if value is None:
            if not self._nullable(spec):
                errors.append((path, 'null'))
            return
        if kind == 'string':
            if not isinstance(value, str):
                errors.append((path, 'type'))
                return
            if 'enum' in resolved and value not in resolved['enum']:
                errors.append((path, 'enum'))
            if 'pattern' in resolved and not self._pattern(resolved['pattern']).search(value):
                errors.append((path, 'pattern'))
            if 'minLength' in resolved and len(value) < resolved['minLength']:
                errors.append((path, 'minLength'))
            return
        if kind in ('integer', 'number'):
            integral = _is_number(value) and float(value).is_integer()
            if not _is_number(value) or (kind == 'integer' and not integral):
                errors.append((path, 'type'))
                return
            if 'min' in resolved and value < resolved['min']:
                errors.append((path, 'min'))
            if 'exclusiveMin' in resolved and value <= resolved['exclusiveMin']:
                errors.append((path, 'min'))
            if 'max' in resolved and value > resolved['max']:
                errors.append((path, 'max'))
            if resolved.get('nonzero') and value == 0:
                errors.append((path, 'nonzero'))
            return
        if kind == 'boolean':
            if not isinstance(value, bool):
                errors.append((path, 'type'))
            return
        if kind == 'array':
            if not isinstance(value, list):
                errors.append((path, 'type'))
                return
            if 'minItems' in resolved and len(value) < resolved['minItems']:
                errors.append((path, 'minItems'))
            if 'maxItems' in resolved and len(value) > resolved['maxItems']:
                errors.append((path, 'maxItems'))
            for index, item in enumerate(value):
                self._check(resolved['items'], item, f'{path}[{index}]', errors)
            return
        if kind == 'map':
            if not isinstance(value, dict):
                errors.append((path, 'type'))
                return
            if 'minEntries' in resolved and len(value) < resolved['minEntries']:
                errors.append((path, 'minEntries'))
            for key, item in value.items():
                self._check(resolved['values'], item, self._join(path, key), errors)
            return
        if kind == 'variant':
            if not isinstance(value, dict):
                errors.append((path, 'type'))
                return
            key = value.get(resolved['on'])
            case = resolved['cases'].get(key) if isinstance(key, str) else None
            if case is None:
                errors.append((self._join(path, resolved['on']), 'variant'))
                return
            self._check(case, value, path, errors)
            return
        if kind == 'object':
            self._check_object(resolved, value, path, errors)
            return
        raise ValueError(f'unknown spec type {kind}')

    @staticmethod
    def _join(path, key):
        return f'{path}.{key}' if path else key

    def _check_object(self, spec, value, path, errors):
        if not isinstance(value, dict):
            errors.append((path, 'type'))
            return
        fields = spec['fields']
        for key in value:
            if key not in fields:
                errors.append((self._join(path, key), 'additional'))
        for key in spec.get('required', []):
            if key not in value:
                errors.append((self._join(path, key), 'missing'))
        for key, field_spec in fields.items():
            if key in value:
                self._check(field_spec, value[key], self._join(path, key), errors)
        for rule in spec.get('rules', []):
            if not self._rule_holds(rule, value, spec):
                errors.append((path, f"rule:{rule['id']}"))

    def _well_formed(self, spec, value):
        errors = []
        self._check(spec, value, '', errors)
        return not errors

    def _rule_holds(self, rule, value, spec):
        when = rule.get('when')
        if when is not None:
            if when['field'] not in value:
                return True
            if not any(_same(value[when['field']], option) for option in when['in']):
                return True
        if 'require' in rule and not all(_present(value, field) for field in rule['require']):
            return False
        if 'forbid' in rule and any(_present(value, field) for field in rule['forbid']):
            return False
        for field, sign in rule.get('sign', {}).items():
            number = value.get(field)
            if _is_number(number) and not (number > 0 if sign == 'positive' else number < 0):
                return False
        if 'exactlyOne' in rule:
            if sum(1 for field in rule['exactlyOne'] if _present(value, field)) != 1:
                return False
        if 'equals' in rule:
            left = value.get(rule['equals']['field'])
            right = value.get(rule['equals']['negate'])
            if _is_number(left) and _is_number(right) and abs(left + right) > 1e-9:
                return False
        if 'lessOrEqual' in rule:
            first, second = rule['lessOrEqual']
            if (_present(value, first) and _present(value, second)
                    and self._well_formed(spec['fields'][first], value[first])
                    and self._well_formed(spec['fields'][second], value[second])
                    and value[first] > value[second]):
                return False
        return True


_READER = None


_PROTOCOL = None


def protocol():
    """The runtime protocol document: {"format", "version", "types", "formats"} (read once)."""
    global _PROTOCOL
    if _PROTOCOL is None:
        _PROTOCOL = json.loads(PROTOCOL_PATH.read_text(encoding='utf-8'))
    return _PROTOCOL


def reader():
    global _READER
    if _READER is None:
        _READER = ContractReader(protocol()['types'])
    return _READER


def check(type_name, value):
    """[(path, code), ...] for value against the named type; [] when it conforms."""
    return reader().check(type_name, value)

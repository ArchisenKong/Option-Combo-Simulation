"""P4: the server's own reading of statement rows (cost_basis_fop_statement.py).

CODE PLAN/COST_BASIS_FOP_STANDALONE_PLAN.md §9.7 and §4.3. The server never
takes the browser's reading on trust for a claim or a binding credential, so
it reads rows itself through the shared mapping. These tests pin that reading
field by field, and against the JS importer: the same row, header and local
time read the same way on both sides.
"""
import copy
import json
import pathlib
import subprocess
import sys
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
for path in (REPO_ROOT, REPO_ROOT / 'tests'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import cost_basis_fop_domain as domain  # noqa: E402
import cost_basis_fop_statement as rows  # noqa: E402

CAPABILITIES = rows.default_capabilities()
MAPPING = CAPABILITIES.mapping
ZONE = domain.SUPPORTED_PRODUCT_RULES['NYMEX-CL-v1']['exchangeTimeZone']
CLZ6 = {'secType': 'FUT', 'contractId': 'fut-cl-202612', 'revision': 1, 'conId': 555, 'root': 'CL',
        'tradingClass': 'CL', 'localSymbol': 'CLZ6', 'exchange': 'NYMEX', 'currency': 'USD',
        'futureContractMonth': '202612', 'futureLastTradeDate': '2026-11-19', 'futureLastTradeAsOf': None,
        'futurePointValue': 1000, 'ruleVersion': 'NYMEX-CL-v1', 'evidenceStatus': 'verified_statement',
        'evidenceSummary': '', 'observedAtUtc': '2027-03-01T14:15:00.000000Z'}
C75 = {'secType': 'FOP', 'contractId': 'fop-cl-lo-20261117-c75', 'revision': 1, 'conId': 9001, 'root': 'CL',
       'tradingClass': 'LO', 'localSymbol': 'LOZ6 C7500', 'exchange': 'NYMEX', 'currency': 'USD',
       'optionRight': 'C', 'optionStrike': 75, 'optionExpiry': '2026-11-17', 'optionExpiryAsOf': None,
       'premiumMultiplier': 1000, 'deliverableFuturesPerOption': 1, 'settlementType': 'physical_future',
       'exerciseStyle': 'american', 'ruleVersion': 'NYMEX-CL-v1', 'evidenceStatus': 'verified_statement',
       'evidenceSummary': '', 'observedAtUtc': '2027-03-01T14:15:00.000000Z'}
TRADE_ROW = {'DataDiscriminator': 'Order', 'Asset Category': 'Futures', 'Currency': 'USD', 'Symbol': 'CLZ6',
             'Date/Time': '2026-10-01, 10:00:00', 'Quantity': '1', 'T. Price': '70', 'Proceeds': '-70000',
             'Comm/Fee': '-2.02', 'Code': 'O'}


def contract_for(ref):
    return {CLZ6['contractId']: CLZ6, C75['contractId']: C75}[ref['contractId']]


def claim():
    record = {'account': 'U1111111', 'namespace': 'activity_row', 'sourceRef': 'act-0000000000000001',
              'capabilityKey': 'activity/trades/FUT/trade', 'format': 'activity_csv', 'section': 'Trades',
              'rawFields': dict(TRADE_ROW), 'statedQuantity': 1, 'statedFees': 2.02}
    event = {'kind': 'futures_trade', 'account': 'U1111111', 'source': 'manual',
             'externalRef': 'act-0000000000000001', 'packageKey': 'pk-00001', 'note': 'by hand',
             'time': {'exchangeTradeDate': None, 'executedAtUtc': '2026-10-01T14:00:00.000000Z',
                      'timeRange': None, 'sourceTimeText': '2026-10-01, 10:00:00',
                      'sourceTimezone': 'America/New_York', 'orderEvidence': None},
             'sources': [{'namespace': 'activity_row', 'sourceRef': 'act-0000000000000001', 'role': 'trade',
                          'quantity': 1, 'fees': 2.02}],
             'contractRef': {'contractId': 'fut-cl-202612', 'revision': 1}, 'futureContracts': 1, 'price': 70,
             'cashAmount': -2.02, 'fees': 2.02, 'openClose': 'O', 'includeInCost': True}
    return record, event


def node(script, payload):
    source = ("const vm = require('./tests/helpers/load-browser-scripts');"
              "const c = vm.loadBrowserScripts(['js/cost_basis_import_common.js', 'js/cost_basis_fop_import.js']);"
              "const statements = require('./tests/helpers/cost_basis_fop_statements.js');"
              f"const input = JSON.parse(process.argv[1]); {script}")
    return json.loads(subprocess.check_output(['node', '-e', source, json.dumps(payload)], cwd=REPO_ROOT,
                                              text=True))


class CapabilityListTests(unittest.TestCase):
    def test_the_shipped_list_writes_nothing_until_a_real_acceptance(self):
        statuses = {entry['status'] for entry in CAPABILITIES.summary()['keys']}
        self.assertEqual(statuses, {'synthetic_only', 'out_of_scope', 'unsupported'})
        self.assertEqual(CAPABILITIES.mapping_version, 'fop-csv-1')
        promoted = CAPABILITIES.with_statuses({'activity/trades/FUT/trade': 'real_verified'})
        self.assertEqual(promoted.status_of('activity/trades/FUT/trade'), 'real_verified')
        self.assertEqual(CAPABILITIES.status_of('activity/trades/FUT/trade'), 'synthetic_only',
                         'a stand-in never changes the shipped list')

    def test_each_status_decides_a_statement_row(self):
        record, event = claim()
        event = dict(event, source='csv_import')
        package = {'sourceRecords': [record], 'events': [event]}
        cases = (
            ('activity/trades/FUT/trade', CAPABILITIES, 'fop_capability_not_verified'),
            ('activity/trades/FOP.cash_settled/any', CAPABILITIES, 'fop_unsupported_row'),
            ('activity/cash_report/ALL/cash', CAPABILITIES, 'invalid_request'),
            ('activity/trades/NOPE/trade', CAPABILITIES, 'invalid_request'),
        )
        for key, capabilities, code in cases:
            with self.subTest(key=key):
                record['capabilityKey'] = key
                with self.assertRaises(domain.FopDomainError) as caught:
                    rows.check_statement_rows(package, capabilities, contract_for=contract_for, exchange_zone=ZONE)
                self.assertEqual(caught.exception.code, code)
        record['capabilityKey'] = 'activity/trades/FUT/trade'
        rows.check_statement_rows(package, CAPABILITIES.with_statuses({record['capabilityKey']: 'real_verified'}),
                                  contract_for=contract_for, exchange_zone=ZONE)
        # A TWS execution is no statement row.
        rows.check_statement_rows({'sourceRecords': [dict(record, namespace='tws_exec', capabilityKey=None)],
                                   'events': []}, CAPABILITIES, contract_for=contract_for, exchange_zone=ZONE)


class ClaimTests(unittest.TestCase):
    def test_a_matching_manual_event_claims_its_row(self):
        record, event = claim()
        self.assertEqual(rows.claim_mismatches(record['capabilityKey'], record, event, event['sources'][0],
                                               contract_for, MAPPING, exchange_zone=ZONE), [])
        rows.check_statement_rows({'sourceRecords': [record], 'events': [event]}, CAPABILITIES,
                                  contract_for=contract_for, exchange_zone=ZONE)

    def test_every_field_a_claim_states_is_checked(self):
        changes = {
            'kind': lambda event, allocation: event.update(kind='option_trade'),
            'role': lambda event, allocation: allocation.update(role='fee'),
            'contract': lambda event, allocation: event.update(contractRef={'contractId': C75['contractId'],
                                                                           'revision': 1}),
            'quantity': lambda event, allocation: event.update(futureContracts=2),
            'price': lambda event, allocation: event.update(price=70.5),
            'fees': lambda event, allocation: allocation.update(fees=1),
            'time': lambda event, allocation: event['time'].update(executedAtUtc='2026-10-01T15:00:00.000000Z'),
            'time text': lambda event, allocation: event['time'].update(sourceTimeText='2026-10-01 10:00'),
        }
        for name, change in changes.items():
            with self.subTest(field=name):
                record, event = claim()
                event = copy.deepcopy(event)
                allocation = event['sources'][0]
                change(event, allocation)
                mismatches = rows.claim_mismatches(record['capabilityKey'], record, event, allocation,
                                                   contract_for, MAPPING, exchange_zone=ZONE)
                self.assertTrue(any(item.startswith(name.split()[0]) for item in mismatches), mismatches)
                with self.assertRaises(domain.FopDomainError) as caught:
                    rows.check_statement_rows({'sourceRecords': [record], 'events': [event]}, CAPABILITIES,
                                              contract_for=contract_for, exchange_zone=ZONE)
                self.assertEqual(caught.exception.code, 'fop_capability_not_verified')


class RowTypeTests(unittest.TestCase):
    """Review P4-4: the server reads a row's type from the row, never from the package."""

    FILLS = [
        {'symbol': 'CLZ6', 'local': '2026-10-01T10:00:00', 'qty': 1, 'price': 70, 'codes': 'O'},
        {'symbol': 'LOZ6 C7500', 'local': '2026-10-01T11:00:00', 'qty': -1, 'price': 1.2, 'codes': 'O'},
        {'symbol': 'LOZ6 P6500', 'local': '2026-10-01T11:30:00', 'qty': 1, 'price': 0.8, 'codes': 'O'},
        {'symbol': 'LOZ6 C7500', 'local': '2026-11-17T16:20:00', 'qty': 1, 'price': 0, 'codes': 'A'},
        {'symbol': 'CLZ6', 'local': '2026-11-17T16:20:00', 'qty': -1, 'price': 75, 'codes': 'A'},
        {'symbol': 'LOZ6 P6500', 'local': '2026-11-17T16:30:00', 'qty': -1, 'price': 0, 'codes': 'Ex'},
        {'symbol': 'CLZ6', 'local': '2026-11-17T16:30:00', 'qty': -1, 'price': 65, 'codes': 'Ex'},
        {'symbol': 'LOF7 C8000', 'local': '2026-11-02T11:00:00', 'qty': -1, 'price': 0.5, 'codes': 'O'},
        {'symbol': 'LOF7 C8000', 'local': '2026-12-16T15:00:00', 'qty': 1, 'price': 0, 'codes': 'Ep'},
    ]

    def test_every_row_the_importer_keys_reads_as_the_same_key_on_the_server(self):
        flex = [dict(fill, tradeId=str(900 + index)) for index, fill in enumerate(self.FILLS)]
        planned = node(
            "const caps = require('./cost_basis_fop_capabilities.json');"
            "const book = {bookId: 'b', account: 'U1111111', symbol: 'CL', currency: 'USD',"
            " fop: {productRules: 'NYMEX-CL-v1', historyScope: 'full_history', engineVersion: 1}};"
            "const out = input.texts.map((text) => { const s = c.OptionComboCostBasisFopImport.readStatement(text,"
            " {capabilities: caps}); const p = c.OptionComboCostBasisFopImport.planImport(s, {book, graph: null,"
            " observedAtUtc: '2027-03-01T14:15:00.000000Z', timeZone: 'America/New_York'});"
            " return p.sourceRecords.map((r) => ({format: p.format, section: r.section, rawFields: r.rawFields,"
            " capabilityKey: r.capabilityKey})); });"
            "process.stdout.write(JSON.stringify(out));",
            {'texts': [
                subprocess.check_output(['node', '-e', f"process.stdout.write(require('./tests/helpers/"
                                         f"cost_basis_fop_statements.js').{kind}(JSON.parse(process.argv[1])))",
                                         json.dumps(options)], cwd=REPO_ROOT, text=True)
                for kind, options in (
                    ('activity', {'period': {'from': '2026-10-01', 'through': '2026-12-31'}, 'fills': self.FILLS}),
                    ('activity', {'period': {'from': '2026-10-01', 'through': '2026-12-31'}, 'fills': self.FILLS,
                                  'chinese': True}),
                    ('flex', {'fills': flex}))]})
        keys = set()
        for records in planned:
            for record in records:
                with self.subTest(key=record['capabilityKey'], format=record['format']):
                    self.assertEqual(rows.row_key(record, MAPPING), record['capabilityKey'])
                keys.add(record['capabilityKey'])
        self.assertEqual(keys, {f'{prefix}/trades/{kind}' for prefix in ('activity', 'flex') for kind in (
            'FUT/trade', 'FOP/trade', 'FOP/assignment', 'FOP/exercise', 'FOP/expiry', 'FUT/delivery_leg')})

    def test_a_row_sent_under_another_key_is_refused(self):
        record, event = claim()
        for code, key in (('A', 'activity/trades/FUT/delivery_leg'), ('Ex', 'activity/trades/FUT/delivery_leg'),
                          ('O', 'activity/trades/FUT/trade')):
            record['rawFields']['Code'] = code
            self.assertEqual(rows.row_key(record, MAPPING), key)
        record['rawFields']['Code'] = 'A'
        package = {'sourceRecords': [record], 'events': [event]}
        with self.assertRaises(domain.FopDomainError) as caught:
            rows.check_statement_rows(package, CAPABILITIES, contract_for=contract_for, exchange_zone=ZONE)
        self.assertEqual(caught.exception.code, 'invalid_request')
        self.assertIn('delivery_leg', str(caught.exception))
        # Even under a real_verified key: the key must be the row's own.
        with self.assertRaises(domain.FopDomainError) as caught:
            rows.check_statement_rows(package, CAPABILITIES.with_statuses({'activity/trades/FUT/trade': 'real_verified'}),
                                      contract_for=contract_for, exchange_zone=ZONE)
        self.assertEqual(caught.exception.code, 'invalid_request')
        # A row that says it is cash settled is unsupported whatever key it is sent under.
        option = dict(record, capabilityKey='activity/trades/FOP/trade', rawFields=dict(
            TRADE_ROW, **{'Asset Category': 'Options On Futures', 'Symbol': 'LOZ6 C7500', 'Settlement Type': 'Cash'}))
        with self.assertRaises(domain.FopDomainError) as caught:
            rows.check_statement_rows({'sourceRecords': [option], 'events': []}, CAPABILITIES,
                                      contract_for=contract_for, exchange_zone=ZONE)
        self.assertEqual(caught.exception.code, 'fop_unsupported_row')


class DatedClaimTests(unittest.TestCase):
    """Review P4-5: a row with only a date is a range the server works out itself."""

    FLEX_ROW = {'ClientAccountID': 'U1111111', 'CurrencyPrimary': 'USD', 'AssetClass': 'FUT', 'Symbol': 'CLZ6',
                'Conid': '555', 'TradeID': '21', 'DateTime': '', 'TradeDate': '20261001', 'Quantity': '1',
                'TradePrice': '70', 'IBCommission': '0', 'Notes/Codes': 'O'}

    def claim(self):
        record, event = claim()
        record = dict(record, namespace='flex_trade', sourceRef='21', capabilityKey='flex/trades/FUT/trade',
                      format='flex_csv', section='Trades', rawFields=dict(self.FLEX_ROW))
        event = copy.deepcopy(event)
        event['sources'][0].update(namespace='flex_trade', sourceRef='21', fees=0)
        event['time'] = {'exchangeTradeDate': '2026-10-01', 'executedAtUtc': None,
                         'timeRange': {'startUtc': '2026-09-30T05:00:00.000000Z',
                                       'endUtc': '2026-10-02T05:00:00.000000Z'},
                         'sourceTimeText': '20261001', 'sourceTimezone': ZONE, 'orderEvidence': None}
        return record, event

    def test_the_range_of_an_exchange_trade_date_is_the_servers_own(self):
        record, event = self.claim()
        self.assertEqual(rows.claim_mismatches(record['capabilityKey'], record, event, event['sources'][0],
                                               contract_for, MAPPING, exchange_zone=ZONE), [])
        changes = {
            'moved': {'timeRange': {'startUtc': '2027-01-01T06:00:00.000000Z', 'endUtc': '2027-01-02T06:00:00.000000Z'}},
            'narrowed': {'timeRange': {'startUtc': '2026-10-01T05:00:00.000000Z', 'endUtc': '2026-10-02T05:00:00.000000Z'}},
            'an instant': {'executedAtUtc': '2026-10-01T15:00:00.000000Z', 'timeRange': None},
            'another zone': {'sourceTimezone': 'America/New_York'},
            'another text': {'sourceTimeText': '2026-10-01'},
        }
        for name, change in changes.items():
            with self.subTest(name):
                changed = copy.deepcopy(event)
                changed['time'].update(change)
                self.assertNotEqual(rows.claim_mismatches(record['capabilityKey'], record, changed,
                                                          changed['sources'][0], contract_for, MAPPING,
                                                          exchange_zone=ZONE), [])

    def test_an_activity_date_covers_its_own_day_in_the_stated_zone(self):
        record, event = claim()
        record['rawFields']['Date/Time'] = '2026-10-01'
        event = copy.deepcopy(event)
        event['time'].update(executedAtUtc=None, sourceTimeText='2026-10-01', timeRange={
            'startUtc': '2026-10-01T04:00:00.000000Z', 'endUtc': '2026-10-02T04:00:00.000000Z'})
        self.assertEqual(rows.claim_mismatches(record['capabilityKey'], record, event, event['sources'][0],
                                               contract_for, MAPPING, exchange_zone=ZONE), [])
        event['time']['timeRange'] = {'startUtc': '2026-10-01T04:00:00.000000Z', 'endUtc': '2026-10-01T16:00:00.000000Z'}
        self.assertTrue(rows.claim_mismatches(record['capabilityKey'], record, event, event['sources'][0],
                                              contract_for, MAPPING, exchange_zone=ZONE))

    def test_day_ranges_match_the_browser(self):
        cases = [('2026-10-01', 'America/Chicago', 1), ('2026-11-02', 'America/Chicago', 1),
                 ('2027-03-15', 'America/Chicago', 1), ('2026-11-01', 'America/New_York', 0),
                 ('2027-01-01', 'Asia/Hong_Kong', 0)]
        browser = node("process.stdout.write(JSON.stringify(input.cases.map(([date, zone, before]) => "
                       "c.OptionComboCostBasisFopImport._internal.dayRange(date, zone, before))));", {'cases': cases})
        for (date, zone, before), seen in zip(cases, browser):
            with self.subTest(date=date, zone=zone):
                self.assertEqual(rows.day_range(date, zone, before), seen)


class BindingEvidenceTests(unittest.TestCase):
    OPTION_ROW = {'Asset Category': 'Options On Futures', 'Symbol': 'LOZ6 C7500', 'Description': 'CL 17NOV26 75 C',
                  'Conid': '9001', 'Underlying': 'CLZ6', 'Listing Exch': 'NYMEX', 'Multiplier': '1000',
                  'Expiry': '2026-11-17', 'Delivery Month': '', 'Type': 'C', 'Strike': '75'}
    FUTURE_ROW = {'Asset Category': 'Futures', 'Symbol': 'CLZ6', 'Description': 'CL 19NOV26', 'Conid': '555',
                  'Underlying': 'CL', 'Listing Exch': 'NYMEX', 'Multiplier': '1000', 'Expiry': '2026-11-19',
                  'Delivery Month': '2026-12', 'Type': '', 'Strike': ''}

    def evidence(self, option=None, future=None):
        return {'format': 'activity_csv', 'rows': [
            {'role': 'option_instrument', 'section': 'Financial Instrument Information',
             'rawFields': dict(self.OPTION_ROW, **(option or {}))},
            {'role': 'future_instrument', 'section': 'Financial Instrument Information',
             'rawFields': dict(self.FUTURE_ROW, **(future or {}))}]}

    def test_rows_that_name_the_option_its_future_and_the_month_prove_the_binding(self):
        self.assertEqual(rows.binding_evidence_problems(self.evidence(), C75, CLZ6, MAPPING), [])
        # Without a delivery-month field, a local symbol that agrees with the month.
        self.assertEqual(rows.binding_evidence_problems(self.evidence(future={'Delivery Month': ''}), C75, CLZ6,
                                                        MAPPING), [])

    def test_anything_short_of_that_is_no_proof(self):
        cases = {
            'another option': ({'Symbol': 'LOZ6 C8000', 'Conid': '9999'}, None, 'names the option'),
            'another underlying': ({'Underlying': 'CLF7'}, None, "underlying future"),
            'another strike': ({'Strike': '80'}, None, 'strike'),
            'another month': (None, {'Delivery Month': '2027-01'}, 'delivery month'),
            'no month at all': (None, {'Delivery Month': '', 'Symbol': 'CL DEC26', 'Conid': '555'}, 'delivery month'),
        }
        for name, (option, future, expected) in cases.items():
            with self.subTest(name):
                problems = rows.binding_evidence_problems(self.evidence(option, future), C75, CLZ6, MAPPING)
                self.assertTrue(any(expected in problem for problem in problems), problems)


class ReadingParityTests(unittest.TestCase):
    """The server reads a row and a local time as the browser importer does."""

    def test_a_chinese_row_maps_its_two_code_columns_the_same_way(self):
        raw = {'DataDiscriminator': 'Order', '资产分类': '期货', '货币': 'USD', '代码': 'CLZ6',
               '日期/时间': '2026-10-01, 10:00:00', '数量': '1', '交易价格': '70', '收益': '-70000',
               '佣金/税': '-2.02', '代码#2': 'O'}
        found = rows.row_values(raw, MAPPING)
        self.assertEqual((found['symbol'], found['codes'], found['dateTime']), ('CLZ6', 'O', '2026-10-01, 10:00:00'))
        headers = [name.split('#')[0] for name in raw]
        mapped = node("const b = c.OptionComboCostBasisImportCommon.buildMapping(input.headers, input.columns);"
                      "process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(b.mapping)"
                      ".map(([k, i]) => [k, input.values[i]]))));",
                      {'headers': headers, 'values': list(raw.values()), 'columns': MAPPING['columns']})
        self.assertEqual(mapped, found)

    def test_local_times_convert_alike(self):
        cases = [('2026-10-01T10:00:00', 'America/New_York'), ('2026-11-01T01:30:00', 'America/New_York'),
                 ('2027-03-14T02:30:00', 'America/New_York'), ('2026-10-01T19:00:00', 'America/Chicago'),
                 ('2026-12-31T23:59:59', 'Asia/Hong_Kong'), ('2026-03-29T01:30:00', 'Europe/London')]
        browser = node("process.stdout.write(JSON.stringify(input.cases.map(([local, zone]) => "
                       "c.OptionComboCostBasisFopImport.localToUtc(local, zone))));", {'cases': cases})
        for (local, zone), seen in zip(cases, browser):
            with self.subTest(local=local, zone=zone):
                server = rows.local_to_utc(local, zone)
                self.assertEqual(set(server), set(seen))
                if 'error' not in server:
                    self.assertEqual(server, seen)
        self.assertEqual(rows.local_timestamp('20261001;190000'), '2026-10-01T19:00:00')
        self.assertEqual(rows.local_timestamp('2026-10-01, 9:05'), '2026-10-01T09:05:00')


if __name__ == '__main__':
    unittest.main()

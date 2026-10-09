import ast
import builtins
import configparser
import pathlib
import tempfile
import unittest
from unittest.mock import patch


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


class ServerConfigEncodingTest(unittest.TestCase):
    def test_utf8_config_under_windows_and_mac_default_encodings(self):
        for server in ('ib_server.py', 'historical_server.py'):
            source = ast.parse((REPO_ROOT / server).read_text(encoding='utf-8'))
            # Execute only config initialization, without starting broker or services.
            initialization = next(
                node for node in source.body
                if isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == 'config'
                        for target in node.targets)
            )
            read = next(
                node for node in source.body
                if isinstance(node, ast.Expr)
                and isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Attribute)
                and isinstance(node.value.func.value, ast.Name)
                and node.value.func.value.id == 'config'
                and node.value.func.attr == 'read'
            )
            code = compile(ast.Module(body=[initialization, read], type_ignores=[]),
                           server, 'exec')
            with tempfile.TemporaryDirectory() as directory:
                fixture = pathlib.Path(directory) / 'config.ini'
                fixture.write_text('; larger \u2014 shared limit\n[server]\n'
                                   'ws_port = 8765\nlabel = \u914d\u7f6e\n', encoding='utf-8')
                for default_encoding in ('gbk', 'utf-8'):
                    with self.subTest(server=server, default_encoding=default_encoding):
                        def open_config(filename, mode='r', encoding=None):
                            self.assertEqual(filename, 'config.ini')
                            if encoding in (None, 'locale'):
                                encoding = default_encoding
                            return builtins.open(fixture, mode,
                                                 encoding=encoding)

                        namespace = {'configparser': configparser}
                        with patch.object(configparser, 'open', open_config, create=True):
                            exec(code, namespace)
                        config = namespace['config']
                        self.assertEqual(config.getint('server', 'ws_port'), 8765)
                        self.assertEqual(config.get('server', 'label'), '\u914d\u7f6e')


if __name__ == '__main__':
    unittest.main()

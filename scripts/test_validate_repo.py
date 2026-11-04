import tempfile
import unittest
from pathlib import Path

from validate_repo import check_documents


class DocumentChecksTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'docs').mkdir()
        self.write('docs/FUNCTIONAL-MATRIX.md', '| F01 | projeto | fonte | teste | PARCIAL |\n| F02 | outro | fonte | teste | P |\n')

    def write(self, name, content):
        (self.root / name).write_text(content, encoding='utf8')

    def test_valid_accents_historical_text_and_partial(self):
        self.write('STATUS.md', '- **F01 parcial:** situação em laboratório.\n- **F02 em desenvolvimento:** histórico.\n')
        self.assertEqual(check_documents(self.root), [])

    def test_mismatched_and_missing_capabilities(self):
        self.write('STATUS.md', '- **F01/F02 parciais:** teste.\n- **F99 validada:** teste.\n')
        errors = check_documents(self.root)
        self.assertTrue(any('F02 declarado PARCIAL, matriz P' in error for error in errors))
        self.assertTrue(any('F99 ausente' in error for error in errors))

    def test_corruption_and_invalid_utf8(self):
        self.write('STATUS.md', 'texto \ufffd e informaÃ§ão\n')
        (self.root / 'docs' / 'bad.md').write_bytes(b'\xff')
        errors = check_documents(self.root)
        self.assertTrue(any('STATUS.md:1' in error for error in errors))
        self.assertTrue(any('bad.md' in error and 'UTF-8 invalido' in error for error in errors))

    def test_newest_explicit_status_wins_over_history(self):
        self.write('STATUS.md', '- **F01 parcial:** atual.\n- **F01 planejada:** histórico.\n')
        self.assertEqual(check_documents(self.root), [])


if __name__ == '__main__':
    unittest.main()

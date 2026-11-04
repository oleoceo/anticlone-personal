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

    def test_replacement_character(self):
        self.write('STATUS.md', 'texto \ufffd\n')
        self.assertEqual(check_documents(self.root), ['STATUS.md:1: possivel texto corrompido'])

    def test_mojibake(self):
        self.write('STATUS.md', 'informaÃ§ão\n')
        self.assertEqual(check_documents(self.root), ['STATUS.md:1: possivel texto corrompido'])

    def test_question_marks_inside_words(self):
        for word in ('reaprova??o', 'transi??o'):
            with self.subTest(word=word):
                self.write('STATUS.md', word + '\n')
                self.assertEqual(check_documents(self.root), ['STATUS.md:1: possivel texto corrompido'])

    def test_invalid_utf8(self):
        (self.root / 'docs' / 'bad.md').write_bytes(b'\xff')
        self.assertEqual(check_documents(self.root), [str(Path('docs/bad.md')) + ': UTF-8 invalido'])

    def test_legitimate_questions_and_technical_examples(self):
        self.write('STATUS.md', 'Reaprovação e transição. Por quê?? Sim?? Não!\n'
                   '`value??fallback` e ``a??b``; operador ?? e URL `https://example.test/a??b`.\n'
                   '```js\nvalue??fallback\n```\n~~~text\na??b\n~~~\n')
        self.assertEqual(check_documents(self.root), [])

    def test_legitimate_indented_code(self):
        self.write('STATUS.md', 'Exemplo JavaScript:\n\n    value??fallback\n\ta??b\n')
        self.assertEqual(check_documents(self.root), [])

    def test_newest_explicit_status_wins_over_history(self):
        self.write('STATUS.md', '- **F01 parcial:** atual.\n- **F01 planejada:** histórico.\n')
        self.assertEqual(check_documents(self.root), [])


if __name__ == '__main__':
    unittest.main()

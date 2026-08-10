import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'design/**', 'fixtures/**', 'scripts/probe/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Обычные .js в репозитории — это скрипты запуска, живущие в ноде.
    // Для .ts глобалы приезжают из типов, здесь их надо назвать.
    files: ['**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    // Инструменты вокруг репозитория ходят по сырому JSON из чужих логов,
    // где схема заранее неизвестна. Типизировать это — сочинять формат.
    files: ['scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)

module.exports = {
  root: true,
  ignorePatterns: ["node_modules/", "coverage/"],
  env: {
    es2021: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  extends: ["eslint:recommended"],
  rules: {
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-empty": "warn",
  },
};

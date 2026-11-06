/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      borderRadius: {
        card: '1.25rem',
      },
      boxShadow: {
        soft: '0 16px 45px rgba(26, 68, 66, 0.10)',
      },
    },
  },
  plugins: [],
};

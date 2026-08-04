/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#0f766e', // teal-700
          dark: '#115e59',
          light: '#ccfbf1',
        },
      },
      // Comfortable tap targets for one-thumb use in poor light.
      minHeight: { tap: '48px' },
    },
  },
  plugins: [],
};

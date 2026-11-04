// Builds public/vendor/tailwind.min.css: run "npm run build:css" after changing classes in the views.
module.exports = {
    darkMode: 'class',
    content: ['./views/**/*.ejs'],
    theme: {
        extend: {
            colors: {
                theme: {
                    bg: 'var(--bg-page)',
                    card: 'var(--bg-card)',
                    nav: 'var(--bg-nav)',
                    text: 'var(--text-main)',
                    subtext: 'var(--text-sub)',
                    highlight: 'var(--highlight)'
                }
            }
        }
    }
};

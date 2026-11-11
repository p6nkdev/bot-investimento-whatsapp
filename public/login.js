const form = document.querySelector('#login-form');
const errorBox = document.querySelector('#login-error');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    form.querySelector('button').setAttribute('aria-busy', 'true');

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) throw new Error(data.error || 'Não foi possível entrar.');
        location.href = '/';
    } catch (error) {
        errorBox.textContent = error.message;
        form.elements.password.select();
    } finally {
        form.querySelector('button').removeAttribute('aria-busy');
    }
});

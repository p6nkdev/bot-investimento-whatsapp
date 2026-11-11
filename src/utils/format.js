function formatMoney(value, quote = 'BRL') {
    if (value === null || value === undefined || value === '') return 'indisponivel';

    const number = Number(value);
    if (!Number.isFinite(number)) return 'indisponivel';

    if (quote === 'BRL') {
        return number.toLocaleString('pt-BR', {
            style: 'currency',
            currency: 'BRL',
            minimumFractionDigits: 2,
        });
    }

    return `${number.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} ${quote}`;
}

module.exports = { formatMoney };

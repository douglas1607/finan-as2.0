const API_URL = 'https://finan-as2-0.onrender.com/api';
let token = localStorage.getItem('financia_token');
let modoPrivado = false;

let chartPortfolio = null;
let chartAsset = null;
let chartPerformance = null;
let chartBalanco = null;
let valoresReaisOcultos = {};
let totalAportesAcumulado = 0;

window.addEventListener('DOMContentLoaded', () => {
    if (!token && !window.location.pathname.includes('login.html')) {
        window.location.href = 'login.html';
        return;
    }

    const nomeUser = localStorage.getItem('financia_user') || 'Usuário';
    const avatar = document.getElementById('avatarLetra');
    if (avatar) avatar.innerText = nomeUser.charAt(0).toUpperCase();

    inicializarGraficos();
    buscarCotacaoBitcoinAoVivo();
    carregarDadosDoBD();
    carregarAtivosPortfolio();
    carregarGastosFixosBD();
    carregarEntradasBD();
    carregarAportesBD();
});

function fazerLogout(e) {
    if (e) e.preventDefault();
    localStorage.removeItem('financia_token');
    localStorage.removeItem('financia_user');
    window.location.href = 'login.html';
}

function alternarFormulario(idForm) {
    const form = document.getElementById(idForm);
    if (form) {
        form.style.display = form.style.display === 'none' || form.style.display === '' ? 'flex' : 'none';
    }
}

function alternarModoPrivacidade() {
    modoPrivado = !modoPrivado;
    const alvos = document.querySelectorAll('.privacy-target');
    const btnPrivado = document.querySelector('.btn-privacy');

    if (btnPrivado) btnPrivado.innerText = modoPrivado ? '👁️ Exibir' : '👁️ Privado';

    alvos.forEach((el, index) => {
        const idChave = el.id || `alvo_${index}`;
        if (modoPrivado) {
            valoresReaisOcultos[idChave] = el.innerText;
            el.innerText = 'R$ ••••••';
        } else {
            if (valoresReaisOcultos[idChave]) el.innerText = valoresReaisOcultos[idChave];
        }
    });
}

function atualizarPatrimonioTotalAuto(totalCalculado) {
    const totalDisplay = document.getElementById('totalPortfolioDisplay');
    if (totalDisplay) {
        totalDisplay.innerText = `R$ ${totalCalculado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    }

    if (chartPortfolio) {
        chartPortfolio.data.datasets[0].data = [totalCalculado];
        chartPortfolio.update();
    }
}

// ==========================================================
// 1. GERENCIAMENTO DE ATIVOS E PORTFÓLIO (Cripto & Ações)
// ==========================================================
async function carregarAtivosPortfolio() {
    try {
        const res = await fetch(`${API_URL}/ativos`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const listaAtivos = await res.json();

        let totalCripto = 0;
        let totalAcoes = 0;
        let totalFiis = 0;

        const container = document.getElementById('listaAtivosCadastrados');
        if (container) container.innerHTML = '';

        for (let item of listaAtivos) {
            let valorCalculado = Number(item.quantidade) * Number(item.preco_medio || 0);

            if (item.tipo === 'Cripto') {
                try {
                    const reqBtc = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${item.ticker.toLowerCase()}&vs_currencies=brl`);
                    const dadosCripto = await reqBtc.json();
                    const precoAtual = dadosCripto[item.ticker.toLowerCase()]?.brl;
                    if (precoAtual) {
                        valorCalculado = Number(item.quantidade) * precoAtual;
                    }
                } catch (e) { }
                totalCripto += valorCalculado;
            } else {
                totalAcoes += valorCalculado;
            }

            if (container) {
                const div = document.createElement('div');
                div.className = 'transaction-item';
                div.innerHTML = `
                    <div>
                        <strong>${item.ticker} (${item.tipo})</strong>
                        <small>Qtd: ${item.quantidade} • Preço Médio: R$ ${Number(item.preco_medio || 0).toFixed(2)} • Total: R$ ${valorCalculado.toFixed(2)}</small>
                    </div>
                    <button onclick="removerAtivo(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir ativo">🗑️</button>
                `;
                container.appendChild(div);
            }
        }

        if (chartAsset) {
            chartAsset.data.datasets[0].data = [totalAportesAcumulado, totalCripto, totalAcoes, totalFiis];
            chartAsset.update();
        }

        const patrimonioGeral = totalAportesAcumulado + totalCripto + totalAcoes + totalFiis;
        atualizarPatrimonioTotalAuto(patrimonioGeral);

    } catch (err) {
        console.log("Erro ao carregar ativos.");
    }
}

async function adicionarAtivoPortfolio() {
    const tipoSelect = document.getElementById('inputTipoAtivo');
    const tickerInput = document.getElementById('inputTickerAtivo');
    const qtdInput = document.getElementById('inputQtdAtivo');
    const precoInput = document.getElementById('inputPrecoUnitarioAtivo');

    const tipo = tipoSelect ? tipoSelect.value : 'Acoes';
    const ticker = tickerInput ? tickerInput.value.trim() : '';
    const quantidade = parseFloat(qtdInput ? qtdInput.value.replace(',', '.') : 0);
    const preco_medio = parseFloat(precoInput ? precoInput.value.replace(',', '.') : 0);

    if (!ticker || isNaN(quantidade) || quantidade <= 0 || isNaN(preco_medio) || preco_medio < 0) {
        alert("Preencha o ticker, a quantidade e o preço unitário válidos.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/ativos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ tipo, ticker, quantidade, preco_medio })
        });

        if (res.ok) {
            tickerInput.value = '';
            qtdInput.value = '';
            precoInput.value = '';
            alternarFormulario('formAlocacao');
            carregarAtivosPortfolio();
        } else {
            const errData = await res.json();
            alert(errData.erro || "Erro ao salvar ativo.");
        }
    } catch (err) {
        alert("Erro ao conectar com o servidor.");
    }
}

async function removerAtivo(id) {
    try {
        await fetch(`${API_URL}/ativos/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        carregarAtivosPortfolio();
    } catch (e) { }
}

// ==========================================================
// 2. ENTRADAS & SALÁRIOS
// ==========================================================
async function carregarEntradasBD() {
    try {
        const res = await fetch(`${API_URL}/entradas`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const lista = await res.json();
        const container = document.getElementById('listaEntradasCadastradas');
        if (!container) return;

        container.innerHTML = '';
        let totalEntradas = 0;

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            totalEntradas += v;

            const div = document.createElement('div');
            div.className = 'transaction-item';
            div.innerHTML = `
                <div>
                    <strong>${item.descricao}</strong>
                    <small>${item.data}</small>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="privacy-target" style="color: var(--verde-destaque); font-weight:700;">+ R$ ${v.toFixed(2).replace('.', ',')}</span>
                    <button onclick="removerEntrada(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir entrada">🗑️</button>
                </div>
            `;
            container.appendChild(div);
        });

        const display = document.getElementById('totalEntradasDisplay');
        if (display) display.innerText = `R$ ${totalEntradas.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

        atualizarGraficoBalanco();
    } catch (e) { }
}

async function adicionarEntrada() {
    const descInput = document.getElementById('entradaDesc');
    const valInput = document.getElementById('entradaVal');

    const descricao = descInput ? descInput.value.trim() : '';
    const valor = parseFloat(valInput ? valInput.value.replace(',', '.') : 0);

    if (!descricao || isNaN(valor) || valor <= 0) {
        alert("Preencha a descrição e o valor da entrada.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/entradas`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ descricao, valor })
        });

        if (res.ok) {
            descInput.value = '';
            valInput.value = '';
            carregarEntradasBD();
        }
    } catch (err) { }
}

async function removerEntrada(id) {
    try {
        const res = await fetch(`${API_URL}/entradas/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarEntradasBD();
    } catch (e) { }
}

// ==========================================================
// 3. EXTRATO E CATEGORIZAÇÃO IA (OPEN FINANCE)
// ==========================================================
async function carregarDadosDoBD() {
    try {
        const res = await fetch(`${API_URL}/extrato`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) { fazerLogout(); return; }
        const lista = await res.json();
        const listContainer = document.getElementById('transactionList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        let tMercado = 0, tCasa = 0, tLazer = 0;

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            if (item.categoria === 'Mercado') tMercado += v;
            else if (item.categoria === 'Casa') tCasa += v;
            else if (item.categoria === 'Lazer') tLazer += v;

            const div = document.createElement('div');
            div.className = 'transaction-item';
            div.innerHTML = `
                <div>
                    <strong>${item.descricao}</strong>
                    <small>${item.data} • [${item.categoria}]</small>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="trans-amount expense privacy-target">- R$ ${v.toFixed(2).replace('.', ',')}</span>
                    <button onclick="removerTransacaoExtrato(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir do extrato">🗑️</button>
                </div>
            `;
            listContainer.appendChild(div);
        });

        document.getElementById('catMercadoDisplay').innerText = `R$ ${tMercado.toFixed(2).replace('.', ',')}`;
        document.getElementById('catCasaDisplay').innerText = `R$ ${tCasa.toFixed(2).replace('.', ',')}`;
        document.getElementById('catLazerDisplay').innerText = `R$ ${tLazer.toFixed(2).replace('.', ',')}`;
        
        atualizarGraficoBalanco();
    } catch (e) { }
}

async function adicionarGastoSimulado(e) {
    if (e) e.preventDefault();
    const descInput = document.getElementById('simDesc');
    const valInput = document.getElementById('simVal');

    const desc = descInput ? descInput.value.trim() : '';
    const val = valInput ? valInput.value.replace(',', '.') : '';

    if (!desc || !val || isNaN(parseFloat(val))) {
        alert("Preencha descrição e valor válidos.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/transacao`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ descricao: desc, valor: val })
        });

        if (res.ok) {
            descInput.value = '';
            valInput.value = '';
            carregarDadosDoBD();
        }
    } catch (err) { }
}

async function removerTransacaoExtrato(id) {
    try {
        const res = await fetch(`${API_URL}/transacao/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarDadosDoBD();
    } catch (e) { }
}

// ==========================================================
// 4. GASTOS FIXOS MENSAIS
// ==========================================================
async function carregarGastosFixosBD() {
    try {
        const res = await fetch(`${API_URL}/gastos-fixos`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const lista = await res.json();
        const listContainer = document.getElementById('fixedExpensesList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        let totalFixed = 0;

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            totalFixed += v;

            const div = document.createElement('div');
            div.className = 'fixed-item';
            div.innerHTML = `
                <div>
                    <strong>${item.descricao}</strong>
                    <small>Vencimento: ${item.vencimento || 'Mensal'}</small>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="fixed-amount privacy-target">R$ ${v.toFixed(2).replace('.', ',')}</span>
                    <button onclick="marcarGastoComoPago(${item.id})" style="background: rgba(0, 255, 136, 0.15); border: 1px solid var(--verde-destaque); color: var(--verde-destaque); padding: 5px 10px; border-radius: 8px; font-weight: 700; cursor: pointer;">✅ Pago</button>
                    <button onclick="removerGastoFixo(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;">🗑️</button>
                </div>
            `;
            listContainer.appendChild(div);
        });

        const totalFixedDisplay = document.getElementById('totalFixedDisplay');
        if (totalFixedDisplay) {
            totalFixedDisplay.innerText = `R$ ${totalFixed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        }
        
        atualizarGraficoBalanco();
    } catch (e) { }
}

async function marcarGastoComoPago(id) {
    try {
        const res = await fetch(`${API_URL}/gastos-fixos/${id}/pago`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            carregarGastosFixosBD();
            carregarDadosDoBD();
        }
    } catch (e) { }
}

async function adicionarGastoFixo() {
    const descInput = document.getElementById('fixedDesc');
    const valInput = document.getElementById('fixedVal');
    const dateInput = document.getElementById('fixedDate');

    const desc = descInput ? descInput.value.trim() : '';
    const val = valInput ? valInput.value.replace(',', '.') : '';
    const date = dateInput ? dateInput.value : '';

    if (!desc || !val || isNaN(parseFloat(val))) {
        alert("Preencha a descrição e o valor.");
        return;
    }

    let dataFormatada = 'Mensal';
    if (date) {
        const partes = date.split('-');
        if (partes.length === 3) dataFormatada = `${partes[2]}/${partes[1]}`;
    }

    try {
        const res = await fetch(`${API_URL}/gastos-fixos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ descricao: desc, valor: val, vencimento: dataFormatada })
        });

        if (res.ok) {
            descInput.value = '';
            valInput.value = '';
            if (dateInput) dateInput.value = '';
            carregarGastosFixosBD();
        }
    } catch (err) { }
}

async function removerGastoFixo(id) {
    try {
        const res = await fetch(`${API_URL}/gastos-fixos/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarGastosFixosBD();
    } catch (e) { }
}

// ==========================================================
// 5. APORTES MENSAIS E GRÁFICOS
// ==========================================================
function inicializarGraficos() {
    const pCanvas = document.getElementById('portfolioChart');
    if (pCanvas) {
        chartPortfolio = new Chart(pCanvas.getContext('2d'), {
            type: 'line',
            data: { labels: ['Início'], datasets: [{ label: 'Patrimônio', data: [0], borderColor: '#00ff88', fill: true }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }

    const aCanvas = document.getElementById('assetChart');
    if (aCanvas) {
        chartAsset = new Chart(aCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { labels: ['Reserva (Aportes)', 'Cripto', 'Ações', 'FIIs'], datasets: [{ data: [0, 0, 0, 0], backgroundColor: ['#00ff88', '#a7ffd5', '#00cc6a', '#1ebd58'] }] },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    const perfCanvas = document.getElementById('performanceChart');
    if (perfCanvas) {
        chartPerformance = new Chart(perfCanvas.getContext('2d'), {
            type: 'bar',
            data: { labels: ['Início'], datasets: [{ label: 'Aporte', data: [0], backgroundColor: '#00ff88' }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }

    const balancoCanvas = document.getElementById('balancoChart');
    if (balancoCanvas) {
        chartBalanco = new Chart(balancoCanvas.getContext('2d'), {
            type: 'bar',
            data: { labels: ['Entradas', 'Saídas'], datasets: [{ label: 'R$', data: [0, 0], backgroundColor: ['#00ff88', '#ff6b6b'] }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }
}

async function carregarAportesBD() {
    try {
        const res = await fetch(`${API_URL}/aportes`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const lista = await res.json();
        
        totalAportesAcumulado = 0;
        if (chartPerformance) {
            chartPerformance.data.labels = [];
            chartPerformance.data.datasets[0].data = [];
        }

        const containerAportes = document.getElementById('listaAportesCadastrados');
        if (containerAportes) containerAportes.innerHTML = '';

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            totalAportesAcumulado += v;

            if (chartPerformance) {
                chartPerformance.data.labels.push(item.mes);
                chartPerformance.data.datasets[0].data.push(v);
            }

            if (containerAportes) {
                const div = document.createElement('div');
                div.className = 'transaction-item';
                div.innerHTML = `
                    <div>
                        <strong>${item.mes}</strong>
                        <small>Aporte de Reserva</small>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="privacy-target" style="color: var(--verde-destaque); font-weight:700;">R$ ${v.toFixed(2).replace('.', ',')}</span>
                        <button onclick="removerAporte(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir aporte">🗑️</button>
                    </div>
                `;
                containerAportes.appendChild(div);
            }
        });

        if (chartPerformance) chartPerformance.update();
        salvarMetaReserva();
        carregarAtivosPortfolio();
        atualizarGraficoBalanco();
    } catch (e) { }
}

async function removerAporte(id) {
    try {
        const res = await fetch(`${API_URL}/aportes/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarAportesBD();
    } catch (e) { }
}

async function adicionarAporteMes() {
    const inputMes = document.getElementById('inputAporteMes');
    const inputVal = document.getElementById('inputAporteVal');

    const m = inputMes ? inputMes.value.trim() : '';
    const v = parseFloat(inputVal ? inputVal.value.replace(',', '.') : 0);

    if (!m || isNaN(v) || v <= 0) {
        alert("Preencha o mês e o valor do aporte.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/aportes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ mes: m, valor: v })
        });

        if (res.ok) {
            inputMes.value = '';
            inputVal.value = '';
            alternarFormulario('formAporte');
            carregarAportesBD();
        }
    } catch (err) { }
}

function atualizarGraficoBalanco() {
    if (!chartBalanco) return;
    const totalEntradas = Array.from(document.querySelectorAll('#listaEntradasCadastradas .transaction-item span'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('+ R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalFixos = Array.from(document.querySelectorAll('#fixedExpensesList .fixed-amount'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalVariaveis = Array.from(document.querySelectorAll('#transactionList .trans-amount'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('- R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalGastosConsumo = totalFixos + totalVariaveis;
    const totalSaidasGeral = totalGastosConsumo + totalAportesAcumulado;
    const saldoLivreReal = totalEntradas - totalSaidasGeral;

    chartBalanco.data.datasets[0].data = [totalEntradas, totalSaidasGeral];
    chartBalanco.update();
}

async function buscarCotacaoBitcoinAoVivo() {
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl&include_24hr_change=true');
        const data = await res.json();
        if (data && data.bitcoin) {
            document.getElementById('btcPreco').innerText = `R$ ${data.bitcoin.brl.toLocaleString('pt-BR')}`;
        }
    } catch (e) { }
}

function salvarPatrimonioInicial() {
    const v = parseFloat(document.getElementById('inputNovoPatrimonio').value) || 0;
    atualizarPatrimonioTotalAuto(v);
    alternarFormulario('formPatrimonio');
}

function salvarMetaReserva() {
    const t = parseFloat(document.getElementById('inputMetaTotal').value) || 10000;
    const metaTextoAtual = document.getElementById('metaTextDisplay');
    const pct = Math.min(Math.round((totalAportesAcumulado / t) * 100), 100);
    if (metaTextoAtual) {
        metaTextoAtual.innerText = `R$ ${totalAportesAcumulado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / R$ ${t.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pct}%)`;
    }
    const barra = document.getElementById('metaProgressBar');
    if (barra) barra.style.width = `${pct}%`;
    alternarFormulario('formMeta');
}

// ==========================================================
// 6. GERAÇÃO COMPLETA DE EXTRATO FINANCEIRO EM PDF
// ==========================================================
async function gerarRelatorioPDF(e) {
    if (e) e.preventDefault();
    if (!window.jspdf) return alert("Biblioteca jsPDF não foi carregada no navegador.");

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const nomeUsuario = localStorage.getItem('financia_user') || 'Usuário';
        let y = 20;

        doc.setFillColor(11, 45, 33);
        doc.rect(0, 0, 210, 30, 'F');
        doc.setTextColor(0, 255, 136);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(18);
        doc.text("FINANCIA AUTÔNOMA", 14, 18);
        
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Relatório Consolidado • Usuário: ${nomeUsuario} • Data: ${new Date().toLocaleDateString('pt-BR')}`, 14, 25);

        y = 40;

        const totalPatrimonio = document.getElementById('totalPortfolioDisplay')?.innerText || 'R$ 0,00';
        const metaReserva = document.getElementById('metaTextDisplay')?.innerText || 'R$ 0,00';

        doc.setTextColor(5, 28, 20);
        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.text("1. RESUMO GERAL", 14, y);
        y += 6;
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Patrimônio Total Calculado: ${totalPatrimonio}`, 14, y);
        y += 5;
        doc.text(`Progresso Meta de Reserva: ${metaReserva}`, 14, y);
        y += 10;

        const buscarDados = async (endpoint) => {
            try {
                const res = await fetch(`${API_URL}/${endpoint}`, { headers: { 'Authorization': `Bearer ${token}` } });
                return res.ok ? await res.json() : [];
            } catch { return []; }
        };

        const [entradas, transacoes, fixos, ativos] = await Promise.all([
            buscarDados('entradas'),
            buscarDados('extrato'),
            buscarDados('gastos-fixos'),
            buscarDados('ativos')
        ]);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("2. ENTRADAS & SALÁRIOS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (entradas.length === 0) {
            doc.text("Nenhuma entrada cadastrada.", 14, y);
            y += 8;
        } else {
            entradas.forEach(item => {
                doc.text(`• ${item.data} - ${item.descricao}: + R$ ${parseFloat(item.valor).toFixed(2)}`, 14, y);
                y += 5;
            });
            y += 3;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("3. GASTOS VARIÁVEIS (Simulador / Categorização IA)", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (transacoes.length === 0) {
            doc.text("Nenhum gasto variável cadastrado.", 14, y);
            y += 8;
        } else {
            transacoes.forEach(item => {
                doc.text(`• ${item.data} - ${item.descricao} [${item.categoria}]: - R$ ${parseFloat(item.valor).toFixed(2)}`, 14, y);
                y += 5;
                if (y > 270) { doc.addPage(); y = 20; }
            });
            y += 3;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("4. COMPROMISSOS FIXOS MENSAIS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (fixos.length === 0) {
            doc.text("Nenhum gasto fixo cadastrado.", 14, y);
            y += 8;
        } else {
            fixos.forEach(item => {
                doc.text(`• ${item.descricao} (Vencimento: ${item.vencimento}): R$ ${parseFloat(item.valor).toFixed(2)}`, 14, y);
                y += 5;
                if (y > 270) { doc.addPage(); y = 20; }
            });
            y += 3;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("5. PORTFÓLIO DE ATIVOS & INVESTIMENTOS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (ativos.length === 0) {
            doc.text("Nenhum ativo cadastrado no portfólio.", 14, y);
            y += 8;
        } else {
            ativos.forEach(item => {
                const totalAtivo = item.quantidade * (item.preco_medio || 0);
                doc.text(`• ${item.ticker} (${item.tipo}) - Qtd: ${item.quantidade} | Preço Médio: R$ ${(item.preco_medio || 0).toFixed(2)} | Total: R$ ${totalAtivo.toFixed(2)}`, 14, y);
                y += 5;
                if (y > 270) { doc.addPage(); y = 20; }
            });
        }

        const paginas = doc.internal.getNumberOfPages();
        for (let i = 1; i <= paginas; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(150, 150, 150);
            doc.text(`FinancIA Autônoma - Documento gerado automaticamente • Página ${i} de ${paginas}`, 14, 288);
        }

        doc.save(`FinancIA_Extrato_Consolidado_${Date.now()}.pdf`);
    } catch (err) {
        console.error("Erro ao gerar PDF:", err);
        alert("Erro ao compilar informações para o PDF.");
    }
}
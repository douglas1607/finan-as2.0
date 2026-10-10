const API_URL = 'https://finan-as2-0.onrender.com/api';
let token = localStorage.getItem('financia_token');
let modoPrivado = false;

let chartPortfolio = null;
let chartAsset = null;
let chartPerformance = null;
let chartBalanco = null;
let valoresReaisOcultos = {};

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
// 1. GERENCIAMENTO DE ATIVOS E PORTFÓLIO
// ==========================================================
async function carregarAtivosPortfolio() {
    try {
        const res = await fetch(`${API_URL}/ativos`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const listaAtivos = await res.json();

        let totalReserva = 0;
        let totalCripto = 0;
        let totalAcoes = 0;
        let totalFiis = 0;

        const container = document.getElementById('listaAtivosCadastrados');
        if (container) container.innerHTML = '';

        for (let item of listaAtivos) {
            let valorCalculado = item.quantidade * (item.preco_medio || 0);

            if (item.tipo === 'Cripto') {
                try {
                    const reqBtc = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${item.ticker.toLowerCase()}&vs_currencies=brl`);
                    const dadosCripto = await reqBtc.json();
                    const precoAtual = dadosCripto[item.ticker.toLowerCase()]?.brl;
                    if (precoAtual) {
                        valorCalculado = item.quantidade * precoAtual;
                    }
                } catch (e) { }
                totalCripto += valorCalculado;
            } else if (item.tipo === 'Reserva') {
                totalReserva += valorCalculado;
            } else {
                totalAcoes += valorCalculado;
            }

            if (container) {
                const div = document.createElement('div');
                div.className = 'transaction-item';
                div.innerHTML = `
                    <div>
                        <strong>${item.ticker} (${item.tipo})</strong>
                        <small>Qtd: ${item.quantidade} • Preço Médio: R$ ${(item.preco_medio || 0).toFixed(2)} • Total: R$ ${valorCalculado.toFixed(2)}</small>
                    </div>
                    <button onclick="removerAtivo(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;">🗑️</button>
                `;
                container.appendChild(div);
            }
        }

        if (chartAsset) {
            chartAsset.data.datasets[0].data = [totalReserva, totalCripto, totalAcoes, totalFiis];
            chartAsset.update();
        }

        const patrimonioGeral = totalReserva + totalCripto + totalAcoes + totalFiis;
        atualizarPatrimonioTotalAuto(patrimonioGeral);

        // Atualiza a barra de progresso da Reserva
        const metaTextoAtual = document.getElementById('metaTextDisplay');
        if (metaTextoAtual) {
            let metaDesejada = 10000;
            const textoAtual = metaTextoAtual.innerText;
            if (textoAtual.includes('/')) {
                const partes = textoAtual.split('/');
                if (partes[1]) {
                    metaDesejada = parseFloat(partes[1].replace('R$', '').replace(/\./g, '').replace(',', '.')) || 10000;
                }
            }
            const pct = Math.min(Math.round((totalReserva / metaDesejada) * 100), 100);
            metaTextoAtual.innerText = `R$ ${totalReserva.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / R$ ${metaDesejada.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pct}%)`;

            const barra = document.getElementById('metaProgressBar');
            if (barra) barra.style.width = `${pct}%`;
        }

    } catch (err) {
        console.log("Erro ao carregar ativos.");
    }
}

async function adicionarAtivoPortfolio() {
    const tipo = document.getElementById('inputTipoAtivo').value;
    const ticker = document.getElementById('inputTickerAtivo').value.trim();
    const quantidade = parseFloat(document.getElementById('inputQtdAtivo').value);
    const precoUnitario = parseFloat(document.getElementById('inputPrecoUnitarioAtivo').value);

    if (!ticker || isNaN(quantidade) || quantidade <= 0 || isNaN(precoUnitario) || precoUnitario < 0) {
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
            body: JSON.stringify({ tipo, ticker, quantidade, preco_medio: tipo === 'Reserva' ? 1 : precoUnitario })
        });

        if (res.ok) {
            document.getElementById('inputTickerAtivo').value = '';
            document.getElementById('inputQtdAtivo').value = '';
            document.getElementById('inputPrecoUnitarioAtivo').value = '';
            alternarFormulario('formAlocacao');
            carregarAtivosPortfolio();
        }
    } catch (err) {
        alert("Erro ao salvar ativo.");
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
// 2. ENTRADAS & SALÁRIOS (Com exclusão 🗑️)
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
    } catch (e) {
        console.log("Erro ao carregar entradas.");
    }
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
    } catch (err) {
        alert("Erro ao salvar entrada.");
    }
}

async function removerEntrada(id) {
    try {
        const res = await fetch(`${API_URL}/entradas/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            carregarEntradasBD();
        } else {
            alert("Erro ao remover entrada.");
        }
    } catch (e) {
        console.log("Erro ao conectar com o servidor.");
    }
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
                <span class="trans-amount expense privacy-target">- R$ ${v.toFixed(2).replace('.', ',')}</span>
            `;
            listContainer.appendChild(div);
        });

        document.getElementById('catMercadoDisplay').innerText = `R$ ${tMercado.toFixed(2).replace('.', ',')}`;
        document.getElementById('catCasaDisplay').innerText = `R$ ${tCasa.toFixed(2).replace('.', ',')}`;
        document.getElementById('catLazerDisplay').innerText = `R$ ${tLazer.toFixed(2).replace('.', ',')}`;
        
        atualizarGraficoBalanco();
    } catch (e) {
        console.log("Erro ao carregar extrato.");
    }
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
        } else {
            alert("Erro ao categorizar transação.");
        }
    } catch (err) {
        alert("Servidor backend indisponível.");
    }
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
                <span class="fixed-amount privacy-target">R$ ${v.toFixed(2).replace('.', ',')}</span>
            `;
            listContainer.appendChild(div);
        });

        const totalFixedDisplay = document.getElementById('totalFixedDisplay');
        if (totalFixedDisplay) {
            totalFixedDisplay.innerText = `R$ ${totalFixed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        }
        
        atualizarGraficoBalanco();
    } catch (e) {
        console.log("Erro ao carregar gastos fixos.");
    }
}

async function adicionarGastoFixo() {
    const descInput = document.getElementById('fixedDesc');
    const valInput = document.getElementById('fixedVal');
    const dateInput = document.getElementById('fixedDate');

    const desc = descInput ? descInput.value.trim() : '';
    const val = valInput ? valInput.value.replace(',', '.') : '';
    const date = dateInput ? dateInput.value : '';

    if (!desc || !val || isNaN(parseFloat(val))) {
        alert("Preencha a descrição e o valor da conta fixa.");
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
    } catch (err) {
        alert("Erro ao salvar gasto fixo.");
    }
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
            data: { labels: ['Reserva', 'Cripto', 'Ações', 'FIIs'], datasets: [{ data: [0, 0, 0, 0], backgroundColor: ['#00ff88', '#a7ffd5', '#00cc6a', '#1ebd58'] }] },
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

function atualizarGraficoBalanco() {
    if (!chartBalanco) return;
    const totalEntradas = Array.from(document.querySelectorAll('#listaEntradasCadastradas .transaction-item span'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('+ R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalFixos = Array.from(document.querySelectorAll('#fixedExpensesList .fixed-amount'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalVariaveis = Array.from(document.querySelectorAll('#transactionList .trans-amount'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('- R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalSaidas = totalFixos + totalVariaveis;

    chartBalanco.data.datasets[0].data = [totalEntradas, totalSaidas];
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
    const t = parseFloat(document.getElementById('inputMetaTotal').value) || 1;
    const a = parseFloat(document.getElementById('inputMetaAtual').value) || 0;
    const pct = Math.min(Math.round((a / t) * 100), 100);
    document.getElementById('metaTextDisplay').innerText = `R$ ${a.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / R$ ${t.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pct}%)`;
    document.getElementById('metaProgressBar').style.width = `${pct}%`;
    alternarFormulario('formMeta');
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

    if (chartPerformance) {
        chartPerformance.data.labels.push(m);
        chartPerformance.data.datasets[0].data.push(v);
        chartPerformance.update();
    }

    // Soma o aporte diretamente no patrimônio total exibido e na Meta de Reserva
    const totalDisplay = document.getElementById('totalPortfolioDisplay');
    if (totalDisplay) {
        let atual = parseFloat(totalDisplay.innerText.replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0;
        atualizarPatrimonioTotalAuto(atual + v);
    }

    const metaTextoAtual = document.getElementById('metaTextDisplay');
    if (metaTextoAtual) {
        let metaDesejada = 10000;
        let reservaAtual = v;
        const textoAtual = metaTextoAtual.innerText;
        if (textoAtual.includes('/')) {
            const partes = textoAtual.split('/');
            if (partes[0]) reservaAtual += (parseFloat(partes[0].replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0);
            if (partes[1]) metaDesejada = parseFloat(partes[1].replace('R$', '').replace(/\./g, '').replace(',', '.')) || 10000;
        }
        const pct = Math.min(Math.round((reservaAtual / metaDesejada) * 100), 100);
        metaTextoAtual.innerText = `R$ ${reservaAtual.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / R$ ${metaDesejada.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pct}%)`;
        const barra = document.getElementById('metaProgressBar');
        if (barra) barra.style.width = `${pct}%`;
    }

    inputMes.value = '';
    inputVal.value = '';
    alternarFormulario('formAporte');
}

async function gerarRelatorioPDF(e) {
    if (e) e.preventDefault();
    if (!window.jspdf) return alert("Biblioteca jsPDF não carregada.");

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text("FinancIA Autônoma - Extrato Mensal", 14, 20);
    doc.save(`FinancIA_Extrato_${Date.now()}.pdf`);
}
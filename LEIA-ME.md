# Painel de treino na nuvem

O GitHub baixa os seus dados do Garmin todo dia às 07:00 (horário de São Paulo), gera o painel e publica uma página **criptografada**. Você abre o endereço no celular, digita a senha e vê o painel de qualquer lugar, sem o seu computador ligado.

## Como a proteção funciona

- A página publicada é pública, mas o conteúdo dentro dela é criptografado (AES-256 com a sua senha). Sem a senha, ninguém lê nada.
- A senha é conferida no seu aparelho. Ela nunca vai para o GitHub nem para ninguém.
- A chave da API do Garmin fica guardada como **segredo** do GitHub: ninguém vê, nem você depois de salvar.
- **A senha é a única barreira.** Use o código aleatório do passo 3. Uma senha curta ou "simples" pode ser descoberta por tentativa, porque o arquivo criptografado é público e dá para testar milhões de senhas por segundo no computador de quem o baixar. Por isso o sistema recusa senhas com menos de 16 caracteres.
- **Login com e-mail do Google:** não existe nesse formato. Uma página estática não consegue verificar o Google sozinha; um botão "Entrar com Google" aqui só pareceria seguro. Para isso seria preciso trocar a hospedagem por uma que faça a verificação (por exemplo, Cloudflare Access ou Firebase), com conta nova e, no caso do Cloudflare, um domínio próprio.

## Passo a passo (uma vez só)

1. **Conta e repositório.** Entre em https://github.com (crie a conta, se precisar, e ative a verificação em duas etapas). Clique em **New repository**, dê um nome (por exemplo `painel-treino`) e marque **Public**. Repositório público é o que permite publicar a página de graça, e não tem nada secreto dentro dele. Crie sem README.
2. **Enviar os arquivos.** Na página do repositório, clique em **uploading an existing file** e arraste para lá **todo o conteúdo** da pasta `nuvem-github` (incluindo a pasta escondida `.github`). Clique em **Commit changes**.
3. **Criar a senha.** No computador, na pasta do projeto, rode `node scripts\nuvem.mjs senha`. Ele mostra um código aleatório só no seu terminal, no formato `abcd-efgh-jkmn-pqrs` (sem letras que se confundem), fácil de digitar. Guarde num gerenciador de senhas. No celular você digita uma vez só: marque **Lembrar neste aparelho**.
4. **Guardar os dois segredos.** No repositório: **Settings → Secrets and variables → Actions → New repository secret**. Crie:
   - `GARMIN_API_KEY`: cole só o valor da chave que está no seu `.env.local` (o que vem depois do `=`).
   - `DASHBOARD_PASSWORD`: cole a senha do passo 3.
5. **Liberar a publicação.** **Settings → Pages → Build and deployment → Source: GitHub Actions**.
6. **Primeira execução.** Aba **Actions → Atualizar painel → Run workflow**. A primeira vez baixa o histórico inteiro e pode levar de 30 a 60 minutos. Depois disso leva poucos minutos. Se o último passo falhar por causa do Pages, confira o passo 5 e clique em **Re-run all jobs**.
7. **Abrir.** O endereço é `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`. Abra no celular, digite a senha e marque **Lembrar neste aparelho**. Pelo menu do navegador, adicione à tela inicial.

## O que você deve saber

- **Atualização:** uma vez por dia, sozinha. O painel mostra, no rodapé, quando foi gerado.
- **Agendamento pausado:** o GitHub desliga agendamentos de repositórios públicos sem atividade por 60 dias. Ele avisa por e-mail; é só entrar em **Actions** e clicar em **Enable workflow**.
- **Falhas:** se um dia der erro (por exemplo, o Garmin fora do ar), a página publicada continua a do dia anterior, e o GitHub avisa por e-mail.
- **Registros públicos:** em repositório público, os registros das execuções (aba Actions) são visíveis para qualquer um. Eles trazem só contagens e datas de download, nunca valores de saúde, a chave ou a senha.
- **Trocar a senha:** troque o segredo `DASHBOARD_PASSWORD` e rode o fluxo de novo. O cache antigo deixa de abrir, então a próxima execução baixa o histórico inteiro outra vez.
- **Se algo vazar:** revogue a chave do Garmin, apague o repositório e crie de novo.
- **Parar tudo:** apague o repositório. A página some junto.
- **Seu computador:** o `servir.cmd` e o `atualizar.cmd` continuam funcionando, com dados separados desta nuvem.

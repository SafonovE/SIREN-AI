(function initSirenExamples(global) {
  "use strict";

  function createId(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return `${prefix}-${global.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createBlankItem() {
    return {
      id: createId("item"),
      title: "",
      before: "",
      after: "",
      clientAction: "",
      supportNote: "",
    };
  }

  function createBlankGroup() {
    return {
      id: createId("group"),
      title: "",
      channels: [],
      location: "",
      availability: "",
      items: [createBlankItem()],
      screenshots: [],
    };
  }

  function createBlankDraft() {
    return {
      schemaVersion: 4,
      title: "",
      releaseDate: "",
      rolloutMode: "",
      rolloutConditions: "",
      groups: [createBlankGroup()],
      support: {
        say: "",
        dontSay: "",
        details: "",
        faq: [],
      },
    };
  }

  const examples = [
    {
      schemaVersion: 4,
      title: "Учебный пример: подтверждение перевода между своими счетами",
      releaseDate: "",
      rolloutMode: "Поэтапное включение",
      rolloutConditions:
        "Учебный сценарий. Новый экран включается поэтапно для авторизованных пользователей веб-ЛК. Дата запуска, суммы, счета и условия вымышлены.",
      groups: [
        {
          id: "demo-own-account-transfer",
          title: "Сводка перед подтверждением перевода",
          channels: ["web"],
          location: "Веб-ЛК → Платежи и переводы → Между своими счетами",
          availability:
            "Авторизованные пользователи веб-ЛК, для которых включён новый экран.",
          items: [
            {
              id: "demo-transfer-fee",
              title: "Комиссия видна до отправки операции",
              before:
                "На форме не было отдельной итоговой сводки. Условие о комиссии нельзя было проверить рядом с кнопкой продолжения.",
              after:
                "Справа от формы появляется блок «Перед подтверждением». В нём отдельно показаны сумма списания и комиссия для текущей операции.",
              clientAction:
                "Проверить сумму и комиссию в сводке, затем нажать «Подтвердить перевод».",
              supportNote:
                "Не переносите цифры из учебного скриншота в консультацию. Пользователь должен ориентироваться только на значения в своём веб-ЛК.",
            },
            {
              id: "demo-transfer-balances",
              title: "Остатки на счетах рассчитаны заранее",
              before:
                "До продолжения пользователь видел текущие балансы счетов, но не видел ожидаемые остатки после перевода в одном месте.",
              after:
                "В сводке показано, сколько останется на счёте списания и сколько будет на счёте зачисления после операции.",
              clientAction:
                "Сопоставить оба ожидаемых остатка со своими намерениями до подтверждения операции.",
              supportNote:
                "Скриншоты содержат вымышленные счета и суммы. Для диагностики попросите клиента назвать только наблюдаемое поведение, не запрашивая полные реквизиты.",
            },
          ],
          screenshots: [
            {
              id: "demo-transfer-before",
              role: "before",
              name: "demo-transfer-before.png",
              title: "Форма без итоговой сводки",
              caption:
                "В прежнем учебном варианте справа нет комиссии и ожидаемых остатков после операции.",
              assetUrl: "web/assets/examples/demo-transfer-before.png",
              width: 1440,
              height: 900,
              layout: "full",
            },
            {
              id: "demo-transfer-after",
              role: "after",
              name: "demo-transfer-after.png",
              title: "Сводка перед подтверждением",
              caption:
                "Один общий скриншот подтверждает оба пункта группы: отдельную комиссию и ожидаемые остатки на счетах.",
              assetUrl: "web/assets/examples/demo-transfer-after.png",
              width: 1440,
              height: 900,
              layout: "full",
            },
          ],
        },
      ],
      support: {
        say:
          "В учебном новом варианте перед подтверждением перевода показывается сводка с суммой, комиссией и ожидаемыми остатками на обоих счетах.",
        dontSay:
          "Не используйте демонстрационные суммы как тариф или обещание нулевой комиссии. Актуальные значения клиент проверяет в своём веб-ЛК.",
        details:
          "Если клиент не видит сводку, проверьте, что перевод выполняется между собственными счетами в веб-ЛК и экран уже включён для пользователя. Не сравнивайте значения клиента с учебными суммами на скриншотах.",
        faq: [
          {
            id: "demo-transfer-faq-fee",
            question: "Почему комиссия на скриншоте равна нулю?",
            answer:
              "Это вымышленное значение учебного макета. В консультации нужно использовать комиссию, которую клиент видит для своей операции.",
          },
          {
            id: "demo-transfer-faq-balance",
            question: "Когда обновятся остатки?",
            answer:
              "Пример показывает только предварительную сводку интерфейса и не задаёт реальный срок проведения операции.",
          },
        ],
      },
    },
  ];

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new global.FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Не удалось прочитать изображение примера"));
      reader.readAsDataURL(blob);
    });
  }

  async function loadAsset(assetUrl) {
    if (typeof global.fetch !== "function") {
      throw new Error("Браузер не поддерживает загрузку изображений примера");
    }
    const response = await global.fetch(assetUrl, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error(`Не удалось загрузить изображение примера: ${assetUrl}`);
    }
    const blob = await response.blob();
    if (!blob.type || !blob.type.startsWith("image/")) {
      throw new Error(`Файл примера не является изображением: ${assetUrl}`);
    }
    return blobToDataUrl(blob);
  }

  async function resolveExample(index) {
    const source = examples[Number(index)];
    if (!source) throw new Error("Учебный пример не найден");

    const draft = deepClone(source);
    const cache = new Map();
    const screenshots = draft.groups.flatMap((group) => group.screenshots || []);
    await Promise.all(screenshots.map(async (screenshot) => {
      if (!screenshot.assetUrl) return;
      if (!cache.has(screenshot.assetUrl)) cache.set(screenshot.assetUrl, loadAsset(screenshot.assetUrl));
      screenshot.dataUrl = await cache.get(screenshot.assetUrl);
      delete screenshot.assetUrl;
    }));
    return draft;
  }

  global.SirenExamples = Object.freeze({
    examples,
    createBlankDraft,
    createBlankGroup,
    createBlankItem,
    resolveExample,
  });
})(window);


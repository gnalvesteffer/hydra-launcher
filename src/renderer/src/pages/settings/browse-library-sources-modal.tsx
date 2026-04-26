import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "@renderer/components";
import { useToast } from "@renderer/hooks";
import { CheckCircleIcon, PlusCircleIcon, SyncIcon } from "@primer/octicons-react";
import "./browse-library-sources-modal.scss";
import { logger } from "@renderer/logger";

interface LibrarySource {
  id: number;
  title: string;
  description: string;
  url: string;
  gamesCount: number;
  status: string[];
  rating: { avg: number; total: number };
}

interface BrowseLibrarySourcesModalProps {
  visible: boolean;
  onClose: () => void;
  onSourceAdded: () => void;
  existingUrls: string[];
}

const LIBRARY_API = "https://api.hydralibrary.com/sources";
const PAGE_SIZE = 50;

export function BrowseLibrarySourcesModal({
  visible,
  onClose,
  onSourceAdded,
  existingUrls,
}: Readonly<BrowseLibrarySourcesModalProps>) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [addingUrls, setAddingUrls] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const { t } = useTranslation("settings");
  const { showSuccessToast, showErrorToast } = useToast();

  useEffect(() => {
    if (!visible) return;
    setIsLoading(true);

    const fetchAll = async () => {
      try {
        // Fetch first page to get total, then fetch remaining pages in parallel
        const firstRes = await fetch(`${LIBRARY_API}?page=1&limit=${PAGE_SIZE}`);
        const firstData = await firstRes.json();
        const allSources: LibrarySource[] = [...firstData.sources];
        const total: number = firstData.total ?? firstData.sources.length;
        const totalPages = Math.ceil(total / PAGE_SIZE);

        if (totalPages > 1) {
          const pagePromises = [];
          for (let p = 2; p <= totalPages; p++) {
            pagePromises.push(
              fetch(`${LIBRARY_API}?page=${p}&limit=${PAGE_SIZE}`).then((r) =>
                r.json()
              )
            );
          }
          const rest = await Promise.all(pagePromises);
          for (const d of rest) {
            allSources.push(...(d.sources ?? []));
          }
        }

        setSources(allSources);
      } catch (err) {
        logger.error("Failed to fetch library sources:", err);
        showErrorToast(t("failed_fetch_library_sources"));
      } finally {
        setIsLoading(false);
      }
    };

    fetchAll();
  }, [visible]);

  const handleAdd = async (source: LibrarySource) => {
    setAddingUrls((prev) => new Set(prev).add(source.url));
    try {
      await window.electron.addDownloadSource(source.url);
      showSuccessToast(t("added_download_source"));
      onSourceAdded();
    } catch (err) {
      logger.error("Failed to add source:", err);
      showErrorToast(t("failed_add_download_source"));
    } finally {
      setAddingUrls((prev) => {
        const next = new Set(prev);
        next.delete(source.url);
        return next;
      });
    }
  };

  const filtered = sources.filter((s) =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );

  const statusBadgeClass = (status: string) => {
    switch (status) {
      case "Trusted":
        return "browse-library-sources-modal__badge--trusted";
      case "Safe For Use":
        return "browse-library-sources-modal__badge--safe";
      case "Abandoned":
        return "browse-library-sources-modal__badge--abandoned";
      default:
        return "browse-library-sources-modal__badge--default";
    }
  };

  return (
    <Modal
      visible={visible}
      title={t("browse_library_sources")}
      description={t("browse_library_sources_description")}
      onClose={onClose}
      large
    >
      <div className="browse-library-sources-modal__container">
        <input
          className="browse-library-sources-modal__search"
          type="text"
          placeholder={t("search_sources")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {isLoading ? (
          <div className="browse-library-sources-modal__loading">
            <SyncIcon className="browse-library-sources-modal__spinner" />
            {t("loading_library_sources")}
          </div>
        ) : (
          <ul className="browse-library-sources-modal__list">
            {filtered.map((source) => {
              const alreadyAdded = existingUrls.includes(source.url);
              const isAdding = addingUrls.has(source.url);

              return (
                <li
                  key={source.id}
                  className="browse-library-sources-modal__item"
                >
                  <div className="browse-library-sources-modal__item-info">
                    <div className="browse-library-sources-modal__item-header">
                      <span className="browse-library-sources-modal__item-title">
                        {source.title}
                      </span>
                      <div className="browse-library-sources-modal__badges">
                        {source.status.map((s) => (
                          <span
                            key={s}
                            className={`browse-library-sources-modal__badge ${statusBadgeClass(s)}`}
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p className="browse-library-sources-modal__item-desc">
                      {source.description}
                    </p>
                    <small className="browse-library-sources-modal__item-meta">
                      {source.gamesCount.toLocaleString()} games
                      {source.rating.total > 0
                        ? ` · ★ ${source.rating.avg.toFixed(1)} (${source.rating.total})`
                        : ""}
                    </small>
                  </div>

                  <Button
                    type="button"
                    theme={alreadyAdded ? "outline" : "primary"}
                    disabled={alreadyAdded || isAdding}
                    onClick={() => handleAdd(source)}
                  >
                    {isAdding ? (
                      <SyncIcon className="browse-library-sources-modal__spinner" />
                    ) : alreadyAdded ? (
                      <CheckCircleIcon />
                    ) : (
                      <PlusCircleIcon />
                    )}
                    {alreadyAdded ? t("already_added") : t("add_download_source")}
                  </Button>
                </li>
              );
            })}
            {filtered.length === 0 && !isLoading && (
              <li className="browse-library-sources-modal__empty">
                {t("no_sources_found")}
              </li>
            )}
          </ul>
        )}
      </div>
    </Modal>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableColumn,
  TableRow,
  TableCell,
  Pagination,
  Spinner,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
} from "@heroui/react";
import { Trash2, Edit3, Users, Plus, MousePointerClick, TrendingUp } from "lucide-react";
import DeleteConfirmationModal from "@/components/block/DeleteConfirmationModal";
import CustomButton from "@/components/block/CustomButton";
import formatDate from "@/utils/formatDate";

const EMPTY_FORM = { username: "", userId: "", commissionRate: "" };

export default function AffiliatePage() {
  const [affiliates, setAffiliates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [rowsPerPage] = useState(10);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const { isOpen, onOpen, onClose } = useDisclosure();

  const totalPages = Math.ceil(affiliates.length / rowsPerPage);
  const paginated = affiliates.slice((page - 1) * rowsPerPage, page * rowsPerPage);

  useEffect(() => {
    fetchAffiliates();
  }, []);

  const fetchAffiliates = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/affiliate");
      const data = await res.json();
      setAffiliates(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to fetch affiliates:", err);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError("");
    onOpen();
  };

  const openEdit = (aff) => {
    setEditId(aff.id || aff._id);
    setForm({
      username: aff.username || "",
      userId: aff.userId || "",
      commissionRate: aff.commissionRate != null ? String(aff.commissionRate) : "",
    });
    setFormError("");
    onOpen();
  };

  const handleSave = async () => {
    if (!form.username.trim()) { setFormError("Username is required"); return; }
    if (!form.userId.trim()) { setFormError("User ID is required"); return; }
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        username: form.username.trim(),
        userId: form.userId.trim(),
        commissionRate: form.commissionRate !== "" ? parseFloat(form.commissionRate) : undefined,
        ...(editId ? { _id: editId } : {}),
      };
      const res = await fetch("/api/affiliate", {
        method: editId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setFormError(data?.error || "Failed to save affiliate"); return; }
      if (editId) {
        setAffiliates((prev) => prev.map((a) => (a.id === editId || a._id === editId ? data : a)));
      } else {
        setAffiliates((prev) => [data, ...prev]);
      }
      onClose();
    } catch (err) {
      setFormError("Unexpected error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      const res = await fetch("/api/affiliate", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: selectedId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || "Suppression impossible");
        return;
      }
      setAffiliates((prev) => prev.filter((a) => a.id !== selectedId && a._id !== selectedId));
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleteModalOpen(false);
      setSelectedId(null);
    }
  };

  const totalClicks = affiliates.reduce((s, a) => s + (a.clicks || 0), 0);
  const totalConversions = affiliates.reduce((s, a) => s + (a.conversions || 0), 0);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-[calc(100vh-80px)]">
        <div className="text-center">
          <Spinner color="secondary" variant="gradient" size="md" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-0 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Affiliates</h1>
          <p className="text-gray-600 text-sm mt-1">
            {affiliates.length} {affiliates.length === 1 ? "affiliate" : "affiliates"} registered
          </p>
        </div>
        <CustomButton onClick={openCreate} intent="primary" size="sm" startContent={<Plus className="w-4 h-4" />}>
          Add Affiliate
        </CustomButton>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Total Affiliates", value: affiliates.length, icon: <Users size={18} />, color: "bg-blue-50 text-blue-600" },
          { label: "Total Clicks", value: totalClicks.toLocaleString(), icon: <MousePointerClick size={18} />, color: "bg-purple-50 text-purple-600" },
          { label: "Total Conversions", value: totalConversions.toLocaleString(), icon: <TrendingUp size={18} />, color: "bg-green-50 text-green-600" },
        ].map((card) => (
          <div key={card.label} className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm flex items-center gap-4">
            <div className={`w-10 h-10 rounded-xl ${card.color} flex items-center justify-center flex-shrink-0`}>
              {card.icon}
            </div>
            <div>
              <p className="text-xs text-gray-500">{card.label}</p>
              <p className="text-lg font-bold text-gray-900">{card.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Table Content */}
      <div className="bg-white rounded-xl overflow-hidden">
        {affiliates.length === 0 ? (
          <div className="p-8 text-center">
            <div className="flex justify-center mb-4">
              <div className="p-3 bg-gray-50 rounded-xl">
                <Users className="w-8 h-8 text-gray-400" />
              </div>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No affiliates yet</h3>
            <p className="text-gray-600 mb-4 text-sm">Create your first affiliate to start tracking referrals.</p>
            <CustomButton onClick={openCreate} className="bg-gradient-to-r from-blue-600 to-purple-600 text-white px-4 py-2 rounded-xl text-sm font-medium">
              <Plus className="w-4 h-4 mr-2" />
              Add First Affiliate
            </CustomButton>
          </div>
        ) : (
          <div className="overflow-hidden">
            {/* Mobile Cards */}
            <div className="block lg:hidden p-4 space-y-3">
              {paginated.map((aff) => (
                <div key={aff.id || aff._id} className="bg-gray-50 rounded-xl p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                      {aff.username?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm">@{aff.username}</p>
                      <p className="text-xs text-gray-500">Commission: {aff.commissionRate ?? 0}%</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="p-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors"
                        onClick={() => openEdit(aff)}
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        className="p-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
                        onClick={() => { setSelectedId(aff.id || aff._id); setDeleteModalOpen(true); }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="bg-white rounded-lg py-2">
                      <p className="text-xs font-semibold text-gray-900">{aff.clicks || 0}</p>
                      <p className="text-[10px] text-gray-500">Clicks</p>
                    </div>
                    <div className="bg-white rounded-lg py-2">
                      <p className="text-xs font-semibold text-gray-900">{aff.conversions || 0}</p>
                      <p className="text-[10px] text-gray-500">Conversions</p>
                    </div>
                    <div className="bg-white rounded-lg py-2">
                      <p className="text-xs font-semibold text-gray-900">{formatDate(aff.createdAt)}</p>
                      <p className="text-[10px] text-gray-500">Joined</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop Table */}
            <div className="hidden lg:block">
              <Table
                shadow="none"
                aria-label="Affiliates Table"
                classNames={{
                  wrapper: "shadow-none border-none rounded-none",
                  th: "bg-gray-50 text-gray-700 font-medium py-3",
                  td: "py-3",
                }}
                bottomContent={
                  affiliates.length > rowsPerPage ? (
                    <div className="w-full flex justify-center p-4 border-t border-gray-200">
                      <Pagination isCompact showControls color="primary" page={page} total={totalPages} onChange={setPage} />
                    </div>
                  ) : null
                }
              >
                <TableHeader>
                  <TableColumn>Affiliate</TableColumn>
                  <TableColumn>Commission</TableColumn>
                  <TableColumn>Clicks</TableColumn>
                  <TableColumn>Conversions</TableColumn>
                  <TableColumn className="hidden xl:table-cell">Joined</TableColumn>
                  <TableColumn className="text-center">Actions</TableColumn>
                </TableHeader>
                <TableBody>
                  {paginated.map((aff) => (
                    <TableRow key={aff.id || aff._id} className="hover:bg-gray-50">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white font-semibold text-xs flex-shrink-0">
                            {aff.username?.charAt(0)?.toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900 text-sm">@{aff.username}</p>
                            <p className="text-xs text-gray-500 truncate max-w-[160px]">{aff.userId}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium text-gray-900">{aff.commissionRate ?? 0}%</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-gray-700">{(aff.clicks || 0).toLocaleString()}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-gray-700">{(aff.conversions || 0).toLocaleString()}</span>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell text-gray-600 text-sm">{formatDate(aff.createdAt)}</TableCell>
                      <TableCell>
                        <div className="flex justify-center gap-2">
                          <button
                            className="p-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors"
                            onClick={() => openEdit(aff)}
                            title="Edit"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            className="p-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors"
                            onClick={() => { setSelectedId(aff.id || aff._id); setDeleteModalOpen(true); }}
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Pagination */}
            {affiliates.length > rowsPerPage && (
              <div className="block lg:hidden p-4 border-t border-gray-200">
                <Pagination isCompact showControls color="primary" page={page} total={totalPages} onChange={setPage} className="flex justify-center" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      <Modal isOpen={isOpen} onClose={onClose} size="md">
        <ModalContent>
          <ModalHeader className="text-gray-900 font-semibold">
            {editId ? "Edit Affiliate" : "Add Affiliate"}
          </ModalHeader>
          <ModalBody className="space-y-4">
            {formError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-2">
                {formError}
              </div>
            )}
            <Input
              label="Username"
              placeholder="e.g. john_doe"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              variant="bordered"
              size="sm"
            />
            <Input
              label="User ID"
              placeholder="e.g. user-uuid-here"
              value={form.userId}
              onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
              variant="bordered"
              size="sm"
            />
            <Input
              label="Commission Rate (%)"
              placeholder="e.g. 10"
              type="number"
              min="0"
              max="100"
              value={form.commissionRate}
              onChange={(e) => setForm((f) => ({ ...f, commissionRate: e.target.value }))}
              variant="bordered"
              size="sm"
            />
          </ModalBody>
          <ModalFooter>
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
            >
              Cancel
            </button>
            <CustomButton onClick={handleSave} isLoading={saving} intent="primary" size="sm">
              {editId ? "Save Changes" : "Create Affiliate"}
            </CustomButton>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <DeleteConfirmationModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDelete}
        title="Delete Affiliate"
        message="Are you sure you want to delete this affiliate? This action cannot be undone."
      />
    </div>
  );
}
